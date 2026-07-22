// api/members — membership, invitations, roles, location grants.
// Invitation tokens are returned to the inviter exactly once and stored hashed.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny, forbidden, ApiError, safeError } from "../../../shared/http.ts";
import { requireUser, requireMember, roleCan } from "../../../shared/authz.ts";
import { logActivity } from "../../../shared/audit.ts";
import { assertWithinLimit } from "../../../shared/entitlements.ts";
import { newInviteToken, newInviteCode, sha256Hex, INVITE_LINK_BASE } from "../../../shared/tokens.ts";

const INVITE_ROLES = ["admin", "manager", "contributor", "viewer", "billing_admin"] as const;
const GRANT_ROLES = ["manager", "contributor", "viewer"] as const;

function publicMember(m: Record<string, any>) {
  return {
    id: m.id,
    user_id: m.user_id,
    user_email: m.user_email,
    member_role: m.member_role,
    status: m.status,
    joined_at: m.joined_at,
  };
}

serveActions({
  list_members: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const members = await ctx.sr.entities.WorkspaceMember.filter({
      workspace_id: ctx.workspace.id,
      status: "active",
    });
    const grants = roleCan(ctx.member.member_role, "manage_members")
      ? await ctx.sr.entities.LocationGrant.filter({ workspace_id: ctx.workspace.id })
      : [];
    return {
      members: members.map((m: Record<string, any>) => ({
        ...publicMember(m),
        grants: grants.filter((g: any) => g.member_id === m.id)
          .map((g: any) => ({ location_id: g.location_id, grant_role: g.grant_role })),
      })),
    };
  },

  create_invitation: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");

    const kind = payload.kind as string;
    if (!["email", "link", "code"].includes(kind)) throw badRequest("kind must be email, link, or code");
    const role = payload.invite_role as string;
    if (!INVITE_ROLES.includes(role as any)) throw badRequest("Invalid role");
    const email = typeof payload.invited_email === "string" ? payload.invited_email.trim().toLowerCase() : "";
    if (kind === "email" && !email) throw badRequest("invited_email required for email invitations");

    const expiresDays = Math.min(Math.max(Number(payload.expires_in_days) || 7, 1), 30);
    const maxUses = kind === "email" ? 1 : Math.min(Math.max(Number(payload.max_uses) || 1, 1), 100);
    const locationIds = Array.isArray(payload.location_ids) ? payload.location_ids.filter((x) => typeof x === "string") : [];

    const raw = kind === "code" ? newInviteCode() : newInviteToken();
    const invitation = await ctx.sr.entities.Invitation.create({
      workspace_id: ctx.workspace.id,
      token_hash: await sha256Hex(raw),
      kind,
      invited_email: email || undefined,
      invite_role: role,
      location_ids: locationIds,
      expires_at: new Date(Date.now() + expiresDays * 86400_000).toISOString(),
      max_uses: maxUses,
      use_count: 0,
      domain_restriction: typeof payload.domain_restriction === "string" ? payload.domain_restriction : undefined,
      // Code/QR invitations always require admin approval per spec.
      requires_approval: kind === "code" ? true : payload.requires_approval === true,
      revoked: false,
      created_by_user_id: ctx.user.id,
    });

    let emailSent = false;
    if (kind === "email") {
      try {
        await ctx.sr.integrations.Core.SendEmail({
          to: email,
          subject: `You're invited to ${ctx.workspace.name} on FindMyBins`,
          body: `<p>${ctx.user.email} invited you to the workspace <strong>${ctx.workspace.name}</strong> on FindMyBins.</p>` +
            `<p><a href="${INVITE_LINK_BASE}${raw}">Accept the invitation</a> (expires in ${expiresDays} days).</p>` +
            `<p>If you don't have an account yet, you can create one after opening the link.</p>`,
          from_name: "FindMyBins",
        });
        emailSent = true;
      } catch (err) {
        // Never log the error object: it echoes the email body, which holds the raw invite token.
        console.error("[members] invitation email failed:", safeError(err));
      }
    }

    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "invitation.created",
      target_type: "invitation", target_id: invitation.id,
      metadata: { kind, invite_role: role, email_sent: emailSent },
    });
    return {
      invitation_id: invitation.id,
      // Raw secret is shown exactly once, to the inviter.
      ...(kind === "code" ? { code: raw } : { link: `${INVITE_LINK_BASE}${raw}` }),
      email_sent: emailSent,
      expires_at: invitation.expires_at,
    };
  },

  list_invitations: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    const invitations = await ctx.sr.entities.Invitation.filter({ workspace_id: ctx.workspace.id, revoked: false });
    return {
      invitations: invitations
        .filter((i: any) => new Date(i.expires_at) > new Date() && i.use_count < i.max_uses)
        .map((i: any) => ({
          id: i.id, kind: i.kind, invited_email: i.invited_email, invite_role: i.invite_role,
          location_ids: i.location_ids ?? [], expires_at: i.expires_at,
          max_uses: i.max_uses, use_count: i.use_count, requires_approval: !!i.requires_approval,
        })),
    };
  },

  revoke_invitation: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    const inv = await ctx.sr.entities.Invitation.get(payload.invitation_id).catch(() => null);
    if (!inv || inv.workspace_id !== ctx.workspace.id) throw deny();
    await ctx.sr.entities.Invitation.update(inv.id, { revoked: true });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "invitation.revoked",
      target_type: "invitation", target_id: inv.id,
    });
    return { revoked: true };
  },

  /** Token in hand ≠ access: validity, expiry, uses, domain, and approval all checked here. */
  accept_invitation: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await requireUser(base44);
    const sr = base44.asServiceRole;

    if (payload.confirm_13_or_over !== true) {
      throw badRequest("Members must confirm they are at least 13 years old");
    }
    const raw = typeof payload.token === "string" ? payload.token.trim() : "";
    if (!raw) throw deny();
    const matches = await sr.entities.Invitation.filter({ token_hash: await sha256Hex(raw) });
    const inv = matches[0];
    if (!inv || inv.revoked || new Date(inv.expires_at) <= new Date() || inv.use_count >= inv.max_uses) {
      throw deny();
    }
    if (inv.invited_email && inv.invited_email !== user.email.toLowerCase()) throw deny();
    if (inv.domain_restriction && !user.email.toLowerCase().endsWith(`@${inv.domain_restriction.toLowerCase()}`)) {
      throw deny();
    }

    const existing = await sr.entities.WorkspaceMember.filter({
      workspace_id: inv.workspace_id, user_id: user.id, status: "active",
    });
    if (existing.length) throw new ApiError(409, "already_member");

    await sr.entities.Invitation.update(inv.id, { use_count: (inv.use_count ?? 0) + 1 });

    if (inv.requires_approval) {
      const jr = await sr.entities.JoinRequest.create({
        workspace_id: inv.workspace_id, invitation_id: inv.id,
        user_id: user.id, user_email: user.email, status: "pending",
      });
      await logActivity(sr, {
        workspace_id: inv.workspace_id, actor: user, action: "join_request.created",
        target_type: "join_request", target_id: jr.id,
      });
      return { status: "pending_approval" };
    }

    await assertWithinLimit(sr, inv.workspace_id, "members");
    const member = await sr.entities.WorkspaceMember.create({
      workspace_id: inv.workspace_id, user_id: user.id, user_email: user.email,
      member_role: inv.invite_role, status: "active",
      invited_by_user_id: inv.created_by_user_id, joined_at: new Date().toISOString(),
    });
    for (const locId of inv.location_ids ?? []) {
      if (GRANT_ROLES.includes(inv.invite_role as any)) {
        await sr.entities.LocationGrant.create({
          workspace_id: inv.workspace_id, member_id: member.id,
          location_id: locId, grant_role: inv.invite_role,
        });
      }
    }
    await logActivity(sr, {
      workspace_id: inv.workspace_id, actor: user, action: "member.joined",
      target_type: "member", target_id: member.id,
    });
    const ws = await sr.entities.Workspace.get(inv.workspace_id);
    return { status: "joined", workspace: { id: ws.id, name: ws.name, workspace_type: ws.workspace_type } };
  },

  list_join_requests: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    const requests = await ctx.sr.entities.JoinRequest.filter({ workspace_id: ctx.workspace.id, status: "pending" });
    return { join_requests: requests.map((r: any) => ({ id: r.id, user_email: r.user_email, created_date: r.created_date })) };
  },

  decide_join_request: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    const jr = await ctx.sr.entities.JoinRequest.get(payload.join_request_id).catch(() => null);
    if (!jr || jr.workspace_id !== ctx.workspace.id || jr.status !== "pending") throw deny();
    const approve = payload.approve === true;

    await ctx.sr.entities.JoinRequest.update(jr.id, {
      status: approve ? "approved" : "denied",
      decided_by_user_id: ctx.user.id,
      decided_at: new Date().toISOString(),
    });
    if (approve) {
      await assertWithinLimit(ctx.sr, ctx.workspace.id, "members");
      const inv = await ctx.sr.entities.Invitation.get(jr.invitation_id).catch(() => null);
      const role = inv?.invite_role ?? "viewer";
      const member = await ctx.sr.entities.WorkspaceMember.create({
        workspace_id: ctx.workspace.id, user_id: jr.user_id, user_email: jr.user_email,
        member_role: role, status: "active", joined_at: new Date().toISOString(),
      });
      for (const locId of inv?.location_ids ?? []) {
        if (GRANT_ROLES.includes(role as any)) {
          await ctx.sr.entities.LocationGrant.create({
            workspace_id: ctx.workspace.id, member_id: member.id, location_id: locId, grant_role: role,
          });
        }
      }
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user,
      action: approve ? "join_request.approved" : "join_request.denied",
      target_type: "join_request", target_id: jr.id,
    });
    return { status: approve ? "approved" : "denied" };
  },

  update_member_role: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    const target = await ctx.sr.entities.WorkspaceMember.get(payload.member_id).catch(() => null);
    if (!target || target.workspace_id !== ctx.workspace.id || target.status !== "active") throw deny();
    const role = payload.member_role as string;
    if (!INVITE_ROLES.includes(role as any)) throw badRequest("Invalid role");
    // Owner role only moves via the ownership-transfer flow.
    if (target.member_role === "owner" || role === "owner") throw forbidden();
    await ctx.sr.entities.WorkspaceMember.update(target.id, { member_role: role });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "member.role_changed",
      target_type: "member", target_id: target.id, metadata: { from: target.member_role, to: role },
    });
    return { member: { ...publicMember(target), member_role: role } };
  },

  remove_member: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    const target = await ctx.sr.entities.WorkspaceMember.get(payload.member_id).catch(() => null);
    if (!target || target.workspace_id !== ctx.workspace.id || target.status !== "active") throw deny();
    if (target.member_role === "owner") throw forbidden();
    await ctx.sr.entities.WorkspaceMember.update(target.id, {
      status: "removed", removed_at: new Date().toISOString(),
    });
    const grants = await ctx.sr.entities.LocationGrant.filter({ workspace_id: ctx.workspace.id, member_id: target.id });
    for (const g of grants) await ctx.sr.entities.LocationGrant.delete(g.id);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "member.removed",
      target_type: "member", target_id: target.id,
    });
    return { removed: true };
  },

  /** Replace a member's location grants (Business/Organization workspaces). */
  set_location_grants: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "manage_members");
    if (ctx.workspace.workspace_type === "household") throw badRequest("Household workspaces do not use location permissions");
    const target = await ctx.sr.entities.WorkspaceMember.get(payload.member_id).catch(() => null);
    if (!target || target.workspace_id !== ctx.workspace.id || target.status !== "active") throw deny();
    if (target.member_role === "owner" || target.member_role === "admin") {
      throw badRequest("Owners and admins always have access to all locations");
    }
    const grants = Array.isArray(payload.grants) ? payload.grants : [];
    for (const g of grants) {
      if (typeof g?.location_id !== "string" || !GRANT_ROLES.includes(g?.grant_role)) {
        throw badRequest("Each grant needs location_id and a valid grant_role");
      }
      const loc = await ctx.sr.entities.Location.get(g.location_id).catch(() => null);
      if (!loc || loc.workspace_id !== ctx.workspace.id) throw deny();
    }
    const old = await ctx.sr.entities.LocationGrant.filter({ workspace_id: ctx.workspace.id, member_id: target.id });
    for (const g of old) await ctx.sr.entities.LocationGrant.delete(g.id);
    for (const g of grants) {
      await ctx.sr.entities.LocationGrant.create({
        workspace_id: ctx.workspace.id, member_id: target.id,
        location_id: g.location_id, grant_role: g.grant_role,
      });
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "grant.changed",
      target_type: "member", target_id: target.id, metadata: { grant_count: grants.length },
    });
    return { grants };
  },
});
