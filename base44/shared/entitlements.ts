// Plan entitlement tables and server-side checks. UI gates are cosmetic only —
// these checks are the enforcement. Downgrades never delete data: over-limit
// workspaces keep view/search/scan/export and lose creation + premium features.

import { ApiError } from "./http.ts";

export type Plan = "free" | "household" | "business";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export interface PlanLimits {
  max_containers: number | null;
  max_members: number | null;
  max_locations: number;
  storage_bytes: number;
  ai_included: boolean;
  ai_trial_actions: number;
  csv_import: boolean;
  custom_fields: boolean;
  natural_language_search: boolean;
  location_permissions: boolean;
  barcode_scanning: boolean;
  advanced_reports: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    max_containers: 10, max_members: 2, max_locations: 2, storage_bytes: 500 * MB,
    ai_included: false, ai_trial_actions: 5, csv_import: false, custom_fields: false,
    natural_language_search: false, location_permissions: false, barcode_scanning: false,
    advanced_reports: false,
  },
  household: {
    max_containers: null, max_members: 10, max_locations: 10, storage_bytes: 10 * GB,
    ai_included: true, ai_trial_actions: 0, csv_import: true, custom_fields: true,
    natural_language_search: true, location_permissions: false, barcode_scanning: false,
    advanced_reports: false,
  },
  business: {
    max_containers: null, max_members: null, max_locations: 25, storage_bytes: 50 * GB,
    ai_included: true, ai_trial_actions: 0, csv_import: true, custom_fields: true,
    natural_language_search: true, location_permissions: true, barcode_scanning: true,
    advanced_reports: true,
  },
};

export const PRICING = {
  household: { monthly_usd: 4.99, annual_usd: 49 },
  business: { monthly_usd: 19, annual_usd: 190, extra_seat_monthly_usd: 2, extra_seat_annual_usd: 20, seats_included: 5 },
  trial_days: 14,
} as const;

export function limitExceeded(feature: string): ApiError {
  return new ApiError(402, "plan_limit", feature);
}

export async function getSubscription(sr: any, workspaceId: string): Promise<Record<string, any>> {
  const subs = await sr.entities.WorkspaceSubscription.filter({ workspace_id: workspaceId });
  // Every workspace gets a subscription record at creation; missing = treat as free.
  return subs[0] ?? { workspace_id: workspaceId, plan: "free", status: "active" };
}

/** Active trial grants the trial plan's entitlements; expired trial falls back to the stored plan. */
export function effectivePlan(sub: Record<string, any>): Plan {
  if (sub.status === "trialing" && sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date()) {
    return (sub.trial_type as Plan) ?? "free";
  }
  return (sub.plan as Plan) ?? "free";
}

export function limitsFor(sub: Record<string, any>): PlanLimits {
  return PLAN_LIMITS[effectivePlan(sub)];
}

/** Hourly cap for paid-plan AI actions; generous for real use, stops bots. */
const AI_HOURLY_LIMIT = 60;

/**
 * Meter one AI action. Free plans consume the 5-action trial; paid plans are
 * unlimited under fair use with an hourly throttle. Manual tools are never
 * affected. The owner gets one notification per throttled hour.
 */
export async function chargeAiAction(sr: any, workspaceId: string): Promise<void> {
  const sub = await getSubscription(sr, workspaceId);
  const limits = limitsFor(sub);

  if (!limits.ai_included) {
    const used = sub.ai_trial_actions_used ?? 0;
    if (used >= limits.ai_trial_actions) throw new ApiError(402, "ai_trial_exhausted");
    if (sub.id) await sr.entities.WorkspaceSubscription.update(sub.id, { ai_trial_actions_used: used + 1 });
    return;
  }

  const bucket = new Date().toISOString().slice(0, 13);
  const count = sub.ai_hour_bucket === bucket ? (sub.ai_hour_count ?? 0) : 0;
  if (count >= AI_HOURLY_LIMIT) {
    if (count === AI_HOURLY_LIMIT && sub.id) {
      // Record the overflow once so the owner is notified exactly once per hour.
      await sr.entities.WorkspaceSubscription.update(sub.id, { ai_hour_count: count + 1 });
      const workspace = await sr.entities.Workspace.get(workspaceId).catch(() => null);
      if (workspace?.owner_user_id) {
        await sr.entities.Notification.create({
          user_id: workspace.owner_user_id,
          workspace_id: workspaceId,
          kind: "ai_throttled",
          title: "AI usage paused for this hour",
          body: "This workspace hit the fair-use hourly AI limit. Manual tools keep working; AI resumes automatically.",
        }).catch(() => {});
      }
    }
    throw new ApiError(429, "ai_throttled");
  }
  if (sub.id) {
    await sr.entities.WorkspaceSubscription.update(sub.id, { ai_hour_bucket: bucket, ai_hour_count: count + 1 });
  }
}

/** At 100% storage, existing media stays accessible but new uploads pause. */
export async function assertStorageAvailable(sr: any, workspaceId: string, addBytes: number): Promise<void> {
  const sub = await getSubscription(sr, workspaceId);
  const used = sub.storage_bytes_used ?? 0;
  if (used + addBytes > limitsFor(sub).storage_bytes) throw limitExceeded("storage");
}

export async function adjustStorageUsed(sr: any, workspaceId: string, deltaBytes: number): Promise<void> {
  const sub = await getSubscription(sr, workspaceId);
  if (!sub.id) return;
  await sr.entities.WorkspaceSubscription.update(sub.id, {
    storage_bytes_used: Math.max(0, (sub.storage_bytes_used ?? 0) + deltaBytes),
  });
}

/** Throws when creating one more of `kind` would exceed the plan. Never blocks reads. */
export async function assertWithinLimit(
  sr: any,
  workspaceId: string,
  kind: "containers" | "members" | "locations",
): Promise<void> {
  const sub = await getSubscription(sr, workspaceId);
  const limits = limitsFor(sub);
  if (kind === "containers" && limits.max_containers !== null) {
    const existing = await sr.entities.Container.filter({ workspace_id: workspaceId });
    if (existing.length >= limits.max_containers) throw limitExceeded("containers");
  }
  if (kind === "members") {
    // Business seats: included seats (min 5, higher for custom deals) + paid extras.
    const seatLimit = effectivePlan(sub) === "business"
      ? Math.max(PRICING.business.seats_included, sub.seats_included ?? 0) + (sub.seats_extra ?? 0)
      : limits.max_members;
    if (seatLimit !== null) {
      const existing = await sr.entities.WorkspaceMember.filter({ workspace_id: workspaceId, status: "active" });
      if (existing.length >= seatLimit) throw limitExceeded("members");
    }
  }
  if (kind === "locations") {
    const existing = await sr.entities.Location.filter({ workspace_id: workspaceId, archived: false });
    if (existing.length >= limits.max_locations) throw limitExceeded("locations");
  }
}
