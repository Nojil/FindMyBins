// crons/billing — daily sweep: trial reminders (7/3/1 days + expiry) and
// storage warnings (80/90/100%). Idempotent via markers on the subscription,
// so an extra invocation can never double-notify.

import { createClientFromRequest } from "npm:@base44/sdk";

// NOTE: automation (scheduled) functions do NOT get base44/shared/ bundled —
// unlike HTTP functions — so the two entitlement helpers this cron needs are
// inlined here. Keep the storage limits in sync with shared/entitlements.ts.
const GB = 1024 * 1024 * 1024;
const STORAGE_BYTES: Record<string, number> = {
  free: 500 * 1024 * 1024,
  household: 10 * GB,
  business: 50 * GB,
};

function effectivePlan(sub: Record<string, any>): string {
  if (sub.status === "trialing" && sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date()) {
    return sub.trial_type ?? "free";
  }
  return sub.plan ?? "free";
}
function storageLimit(sub: Record<string, any>): number {
  return STORAGE_BYTES[effectivePlan(sub)] ?? STORAGE_BYTES.free;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const now = Date.now();
  let trialNotices = 0;
  let storageNotices = 0;

  const subs = await sr.entities.WorkspaceSubscription.filter({}, "-updated_date", 500);
  for (const sub of subs) {
    const workspace = await sr.entities.Workspace.get(sub.workspace_id).catch(() => null);
    if (!workspace?.owner_user_id) continue;

    const notifyOwner = (kind: string, title: string, body: string) =>
      sr.entities.Notification.create({
        user_id: workspace.owner_user_id, workspace_id: sub.workspace_id, kind, title, body,
      }).catch(() => {});

    // Trial reminders
    if (sub.status === "trialing" && sub.trial_ends_at) {
      const daysLeft = Math.ceil((new Date(sub.trial_ends_at).getTime() - now) / 86400_000);
      const sent: string[] = sub.trial_reminders_sent ?? [];
      const due = daysLeft <= 0 ? "expired" : daysLeft <= 1 ? "1" : daysLeft <= 3 ? "3" : daysLeft <= 7 ? "7" : null;
      if (due && !sent.includes(due)) {
        if (due === "expired") {
          await notifyOwner("trial_ended",
            "Your trial has ended",
            "Your workspace is back on the Free plan. Everything you created is safe and searchable — upgrade any time to keep the premium features.");
          await sr.entities.WorkspaceSubscription.update(sub.id, {
            status: "active", trial_reminders_sent: [...sent, due],
          });
        } else {
          await notifyOwner("trial_reminder",
            `${due} day${due === "1" ? "" : "s"} left in your trial`,
            `Your ${sub.trial_type ?? "paid"} trial ends soon. Upgrade to keep unlimited containers and AI assistance.`);
          await sr.entities.WorkspaceSubscription.update(sub.id, { trial_reminders_sent: [...sent, due] });
        }
        trialNotices++;
      }
    }

    // Storage warnings at 80 / 90 / 100 percent
    const limitBytes = storageLimit(sub);
    const pct = limitBytes > 0 ? Math.floor(((sub.storage_bytes_used ?? 0) / limitBytes) * 100) : 0;
    const tier = pct >= 100 ? 100 : pct >= 90 ? 90 : pct >= 80 ? 80 : 0;
    const lastSent = sub.storage_warning_sent ?? 0;
    if (tier > lastSent) {
      await notifyOwner("storage_warning",
        tier >= 100 ? "Storage is full" : `Storage ${tier}% full`,
        tier >= 100
          ? "New photo and file uploads are paused. Existing media stays available — free up space or upgrade to continue uploading."
          : `This ${effectivePlan(sub)} workspace has used ${tier}% of its storage.`);
      await sr.entities.WorkspaceSubscription.update(sub.id, { storage_warning_sent: tier });
      storageNotices++;
    } else if (tier < lastSent) {
      // Usage dropped back below a warned tier — re-arm the warnings.
      await sr.entities.WorkspaceSubscription.update(sub.id, { storage_warning_sent: tier });
    }
  }

  return Response.json({ ok: true, trial_notices: trialNotices, storage_notices: storageNotices });
});
