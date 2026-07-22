// api/dashboard — home-screen data. Every count is computed strictly within
// the caller's accessible locations, so dashboards can never leak the size or
// existence of hidden inventory (count isolation).

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds, roleCan } from "../../../shared/authz.ts";
import { getSubscription, effectivePlan, limitsFor } from "../../../shared/entitlements.ts";
import { formatNumber } from "../../../shared/numbering.ts";

serveActions({
  overview: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const accessible = await accessibleLocationIds(ctx);
    const scoped = (locId: string) => accessible === null || accessible.has(locId);

    const [locations, containers, items, sub] = await Promise.all([
      ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id }),
      ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000),
      ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000),
      getSubscription(ctx.sr, ctx.workspace.id),
    ]);
    const locById = new Map(locations.map((l: any) => [l.id, l]));

    const myLocations = locations.filter((l: any) => !l.archived && scoped(l.id));
    const myContainers = containers.filter((c: any) => !c.archived && scoped(c.location_id));
    const myItems = items.filter((i: any) =>
      !i.deleted_at && !i.archived && scoped(i.location_id)
    );

    const overview: Record<string, unknown> = {
      workspace: {
        id: ctx.workspace.id, name: ctx.workspace.name,
        workspace_type: ctx.workspace.workspace_type, my_role: ctx.member.member_role,
        plan: effectivePlan(sub),
      },
      totals: {
        containers: myContainers.length,
        items: myItems.filter((i: any) => i.state === "confirmed").length,
        locations: myLocations.length,
      },
      unprinted_labels: myContainers.filter((c: any) => c.label_status !== "printed").length,
      pending_ai_drafts: myItems.filter((i: any) => i.state === "draft").length,
      recent_containers: myContainers.slice(0, 5).map((c: any) => ({
        id: c.id, number_display: c.number ? formatNumber(c.number) : null,
        title: c.title, container_type: c.container_type,
        location_path: locById.get(c.location_id)?.path_text ?? null,
        updated_date: c.updated_date,
      })),
      locations: myLocations
        .filter((l: any) => !l.parent_id || (accessible !== null && !scoped(l.parent_id)))
        .map((root: any) => ({
          id: root.id, name: root.name, path_text: root.path_text,
          container_count: myContainers.filter((c: any) =>
            c.location_id === root.id ||
            (locById.get(c.location_id)?.path_ids ?? []).includes(root.id)
          ).length,
        })),
      storage: {
        bytes_used: sub.storage_bytes_used ?? 0,
        bytes_limit: limitsFor(sub).storage_bytes,
      },
    };

    // Business/Organization extras, only for roles that may see them.
    if (ctx.workspace.workspace_type !== "household" && roleCan(ctx.member.member_role, "view_activity")) {
      const events = await ctx.sr.entities.ActivityEvent.filter(
        { workspace_id: ctx.workspace.id }, "-created_date", 15,
      );
      overview.recent_activity = events.map((e: any) => ({
        action: e.action, actor_email: e.actor_email,
        target_type: e.target_type, target_label: e.target_label, created_date: e.created_date,
      }));
      overview.recent_permission_changes = events
        .filter((e: any) => ["grant.changed", "member.role_changed", "member.removed", "member.joined"].includes(e.action))
        .map((e: any) => ({ action: e.action, actor_email: e.actor_email, created_date: e.created_date }));
    }
    if (ctx.workspace.workspace_type !== "household" && roleCan(ctx.member.member_role, "manage_members")) {
      const members = await ctx.sr.entities.WorkspaceMember.filter({
        workspace_id: ctx.workspace.id, status: "active",
      });
      overview.member_count = members.length;
    }
    return overview;
  },
});
