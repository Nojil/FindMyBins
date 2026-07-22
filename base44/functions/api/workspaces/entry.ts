// api/workspaces — profile bootstrap, workspace lifecycle basics.
// All access authorized via shared/authz.ts before any retrieval.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny } from "../../../shared/http.ts";
import { requireUser, requireMember } from "../../../shared/authz.ts";
import { logActivity } from "../../../shared/audit.ts";
import { getSubscription, effectivePlan, limitsFor } from "../../../shared/entitlements.ts";

const WORKSPACE_TYPES = ["household", "business", "organization"] as const;
const CURRENT_TERMS_VERSION = "2026-07";
const RECOVERY_DAYS = 30;

async function getOrCreateProfile(sr: any, user: { id: string; email: string }) {
  const existing = await sr.entities.UserProfile.filter({ user_id: user.id });
  if (existing.length) return existing[0];
  return await sr.entities.UserProfile.create({ user_id: user.id });
}

serveActions({
  /** First call after login: profile + memberships + workspace summaries. */
  bootstrap: async (_payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await requireUser(base44);
    const sr = base44.asServiceRole;

    const profile = await getOrCreateProfile(sr, user);
    const memberships = await sr.entities.WorkspaceMember.filter({ user_id: user.id, status: "active" });
    const workspaces = [];
    for (const m of memberships) {
      const ws = await sr.entities.Workspace.get(m.workspace_id).catch(() => null);
      if (!ws) continue;
      const sub = await getSubscription(sr, ws.id);
      workspaces.push({
        id: ws.id,
        name: ws.name,
        workspace_type: ws.workspace_type,
        status: ws.status,
        my_role: m.member_role,
        plan: effectivePlan(sub),
      });
    }
    return { profile: publicProfile(profile), terms_version: CURRENT_TERMS_VERSION, workspaces };
  },

  update_profile: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await requireUser(base44);
    const sr = base44.asServiceRole;
    const profile = await getOrCreateProfile(sr, user);

    const patch: Record<string, unknown> = {};
    if (typeof payload.display_name === "string") patch.display_name = payload.display_name.slice(0, 120);
    if (payload.theme === "system" || payload.theme === "light" || payload.theme === "dark") {
      patch.theme = payload.theme;
    }
    if (payload.accept_terms === true) {
      patch.terms_accepted_at = new Date().toISOString();
      patch.terms_version = CURRENT_TERMS_VERSION;
    }
    if (payload.confirm_18_or_over === true) {
      patch.is_18_or_over = true;
      patch.age_confirmed_at = new Date().toISOString();
    }
    if (typeof payload.search_history_enabled === "boolean") {
      patch.search_history_enabled = payload.search_history_enabled;
    }
    if (Number.isInteger(payload.search_history_expiry_days) && (payload.search_history_expiry_days as number) >= 0) {
      patch.search_history_expiry_days = payload.search_history_expiry_days;
    }
    if (typeof payload.analytics_opt_out === "boolean") patch.analytics_opt_out = payload.analytics_opt_out;
    const updated = await sr.entities.UserProfile.update(profile.id, patch);
    return { profile: publicProfile(updated) };
  },

  /** Creating a workspace requires an 18+ attestation and accepted terms. */
  create_workspace: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await requireUser(base44);
    const sr = base44.asServiceRole;

    const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "";
    const type = payload.workspace_type as string;
    if (!name) throw badRequest("Workspace name is required");
    if (!WORKSPACE_TYPES.includes(type as any)) throw badRequest("Invalid workspace type");

    const profile = await getOrCreateProfile(sr, user);
    if (!profile.is_18_or_over) throw badRequest("Workspace owners must confirm they are 18 or older");
    if (!profile.terms_accepted_at) throw badRequest("Terms must be accepted first");

    const workspace = await sr.entities.Workspace.create({
      name,
      workspace_type: type,
      owner_user_id: user.id,
      status: "active",
    });
    await sr.entities.WorkspaceMember.create({
      workspace_id: workspace.id,
      user_id: user.id,
      user_email: user.email,
      member_role: "owner",
      status: "active",
      joined_at: new Date().toISOString(),
    });
    await sr.entities.WorkspaceSubscription.create({ workspace_id: workspace.id, plan: "free", status: "active" });
    await logActivity(sr, {
      workspace_id: workspace.id,
      actor: user,
      action: "workspace.created",
      target_type: "workspace",
      target_id: workspace.id,
      target_label: name,
    });
    return { workspace: { id: workspace.id, name, workspace_type: type, my_role: "owner", plan: "free" } };
  },

  /** 14-day no-card trial of the workspace type's paid plan; one per type per account. */
  start_trial: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "billing");
    const trialType = ctx.workspace.workspace_type === "household" ? "household" : "business";
    const profileFlag = trialType === "household" ? "trial_used_household" : "trial_used_business";

    const profile = await getOrCreateProfile(ctx.sr, ctx.user);
    if (profile[profileFlag]) throw badRequest(`You have already used your ${trialType} trial`);
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    if (effectivePlan(sub) !== "free") throw badRequest("This workspace already has a paid plan or active trial");

    const trialEndsAt = new Date(Date.now() + 14 * 86400_000).toISOString();
    await ctx.sr.entities.WorkspaceSubscription.update(sub.id, {
      status: "trialing",
      trial_type: trialType,
      trial_ends_at: trialEndsAt,
    });
    await ctx.sr.entities.UserProfile.update(profile.id, { [profileFlag]: true });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "subscription.changed",
      target_type: "subscription", target_id: sub.id,
      metadata: { change: "trial_started", trial_type: trialType, trial_ends_at: trialEndsAt },
    });
    return { plan: trialType, status: "trialing", trial_ends_at: trialEndsAt };
  },

  get_workspace: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    const canSeeBilling = ctx.member.member_role === "owner" || ctx.member.member_role === "billing_admin";
    return {
      workspace: {
        id: ctx.workspace.id,
        name: ctx.workspace.name,
        workspace_type: ctx.workspace.workspace_type,
        status: ctx.workspace.status,
        settings: ctx.workspace.settings ?? {},
        categories: ctx.workspace.categories ?? [],
        custom_container_types: ctx.workspace.custom_container_types ?? [],
        my_role: ctx.member.member_role,
        plan: effectivePlan(sub),
        ...(canSeeBilling
          ? {
            subscription: {
              status: sub.status,
              trial_ends_at: sub.trial_ends_at,
              seats_included: sub.seats_included,
              seats_extra: sub.seats_extra,
              storage_bytes_used: sub.storage_bytes_used ?? 0,
              storage_bytes_limit: limitsFor(sub).storage_bytes,
            },
          }
          : {}),
        ...(ctx.workspace.status === "pending_deletion"
          ? {
            deletion: {
              requested_at: ctx.workspace.deletion_requested_at,
              effective_at: ctx.workspace.deletion_effective_at,
            },
          }
          : {}),
      },
    };
  },

  /**
   * Ownership transfer — owner only, target must already be an admin.
   * Typed confirmation of the workspace name is the server-enforced gate
   * (clients additionally require a fresh re-authentication before showing it).
   */
  transfer_ownership: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "transfer_ownership");
    if (payload.confirm_name !== ctx.workspace.name) {
      throw badRequest("Type the workspace name exactly to confirm the transfer");
    }
    const target = await ctx.sr.entities.WorkspaceMember.get(payload.member_id).catch(() => null);
    if (!target || target.workspace_id !== ctx.workspace.id || target.status !== "active") throw deny();
    if (target.member_role !== "admin") throw badRequest("Ownership can only transfer to an existing admin");

    await ctx.sr.entities.WorkspaceMember.update(target.id, { member_role: "owner" });
    await ctx.sr.entities.WorkspaceMember.update(ctx.member.id, { member_role: "admin" });
    await ctx.sr.entities.Workspace.update(ctx.workspace.id, { owner_user_id: target.user_id });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "ownership.transferred",
      target_type: "member", target_id: target.id, target_label: target.user_email,
      metadata: { from_user_id: ctx.user.id, to_user_id: target.user_id },
    });
    // Both parties are notified, per the security-notification policy.
    for (const [userId, title, body] of [
      [ctx.user.id, "You transferred ownership", `${target.user_email} is now the owner of ${ctx.workspace.name}. You are now an admin.`],
      [target.user_id, "You are now the owner", `${ctx.user.email} transferred ownership of ${ctx.workspace.name} to you.`],
    ] as const) {
      await ctx.sr.entities.Notification.create({
        user_id: userId, workspace_id: ctx.workspace.id, kind: "ownership_transferred", title, body,
      }).catch(() => {});
    }
    return { transferred: true, new_owner_user_id: target.user_id };
  },

  /** Start the 30-day deletion window. Members lose access immediately. */
  request_workspace_deletion: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "delete_workspace");
    if (payload.confirm_name !== ctx.workspace.name) {
      throw badRequest("Type the workspace name exactly to confirm deletion");
    }
    if (ctx.workspace.status === "pending_deletion") throw badRequest("Deletion is already scheduled");

    const now = new Date();
    const effective = new Date(now.getTime() + RECOVERY_DAYS * 86400_000);
    await ctx.sr.entities.Workspace.update(ctx.workspace.id, {
      status: "pending_deletion",
      deletion_requested_at: now.toISOString(),
      deletion_effective_at: effective.toISOString(),
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "workspace.deletion_requested",
      target_type: "workspace", target_id: ctx.workspace.id, target_label: ctx.workspace.name,
      metadata: { effective_at: effective.toISOString() },
    });
    // Notify every admin so a deletion can never happen quietly.
    const members = await ctx.sr.entities.WorkspaceMember.filter({
      workspace_id: ctx.workspace.id, status: "active",
    });
    for (const m of members) {
      if (!["owner", "admin"].includes(m.member_role)) continue;
      await ctx.sr.entities.Notification.create({
        user_id: m.user_id, workspace_id: ctx.workspace.id, kind: "workspace_deletion_requested",
        title: `${ctx.workspace.name} is scheduled for deletion`,
        body: `All data is permanently removed on ${effective.toISOString().slice(0, 10)}. The owner can restore it until then.`,
      }).catch(() => {});
    }
    return { status: "pending_deletion", effective_at: effective.toISOString() };
  },

  /** Restore during the recovery window. */
  cancel_workspace_deletion: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "delete_workspace");
    if (ctx.workspace.status !== "pending_deletion") throw badRequest("This workspace isn't scheduled for deletion");
    await ctx.sr.entities.Workspace.update(ctx.workspace.id, {
      status: "active", deletion_requested_at: null, deletion_effective_at: null,
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "workspace.deletion_canceled",
      target_type: "workspace", target_id: ctx.workspace.id, target_label: ctx.workspace.name,
    });
    return { status: "active" };
  },

  /**
   * Can this account be deleted? Owners must transfer or delete their
   * workspaces first, so the answer names the blockers.
   */
  account_deletion_status: async (_payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await requireUser(base44);
    const sr = base44.asServiceRole;
    const memberships = await sr.entities.WorkspaceMember.filter({
      user_id: user.id, status: "active", member_role: "owner",
    });
    const blockers = [];
    for (const m of memberships) {
      const ws = await sr.entities.Workspace.get(m.workspace_id).catch(() => null);
      if (ws) blockers.push({ workspace_id: ws.id, name: ws.name, status: ws.status });
    }
    return { can_delete: blockers.length === 0, owned_workspaces: blockers };
  },

  /** Delete the personal account once no owned workspaces remain. */
  delete_account: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await requireUser(base44);
    const sr = base44.asServiceRole;
    if (payload.confirm !== "DELETE") throw badRequest('Type DELETE to confirm');

    const owned = await sr.entities.WorkspaceMember.filter({
      user_id: user.id, status: "active", member_role: "owner",
    });
    if (owned.length) {
      throw badRequest("Transfer ownership or delete your workspaces before deleting your account");
    }
    // Leave every workspace, then remove personal records.
    const memberships = await sr.entities.WorkspaceMember.filter({ user_id: user.id, status: "active" });
    for (const m of memberships) {
      await sr.entities.WorkspaceMember.update(m.id, { status: "removed", removed_at: new Date().toISOString() });
      const grants = await sr.entities.LocationGrant.filter({ workspace_id: m.workspace_id, member_id: m.id });
      for (const g of grants) await sr.entities.LocationGrant.delete(g.id);
      await logActivity(sr, {
        workspace_id: m.workspace_id, actor: user, action: "member.removed",
        target_type: "member", target_id: m.id, metadata: { reason: "account_deleted" },
      });
    }
    for (const entity of ["SearchHistory", "Notification", "NotificationPref", "PushToken", "UserProfile"]) {
      const records = await sr.entities[entity].filter({ user_id: user.id });
      for (const r of records) await sr.entities[entity].delete(r.id);
    }
    return { deleted: true };
  },
});

function publicProfile(p: Record<string, any>) {
  return {
    id: p.id,
    display_name: p.display_name,
    theme: p.theme ?? "system",
    is_18_or_over: !!p.is_18_or_over,
    terms_accepted_at: p.terms_accepted_at,
    terms_version: p.terms_version,
    search_history_enabled: p.search_history_enabled !== false,
    analytics_opt_out: !!p.analytics_opt_out,
    default_workspace_id: p.default_workspace_id,
  };
}
