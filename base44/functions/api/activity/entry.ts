// api/activity — audit trail viewing and the unified recovery ("trash") view.
// Activity events never contain private search text (they aren't written with
// it), and are visible only to roles holding view_activity. Recovery lists
// every soft-deleted record still inside its 30-day window, scoped to the
// caller's accessible locations.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds } from "../../../shared/authz.ts";
import { getSubscription, effectivePlan } from "../../../shared/entitlements.ts";

/** Documented retention windows by plan; critical events are exempt. */
export const RETENTION_DAYS: Record<string, number> = {
  free: 30,
  household: 365,
  business: 1095,
};

serveActions({
  list: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "view_activity");
    const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 200);
    const events = await ctx.sr.entities.ActivityEvent.filter(
      { workspace_id: ctx.workspace.id }, "-created_date", limit,
    );
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    return {
      retention_days: RETENTION_DAYS[effectivePlan(sub)] ?? 30,
      events: events
        .filter((e: any) => typeof payload.action !== "string" || e.action === payload.action)
        .map((e: any) => ({
          id: e.id,
          action: e.action,
          actor_email: e.actor_email ?? null,
          target_type: e.target_type ?? null,
          target_label: e.target_label ?? null,
          metadata: e.metadata ?? {},
          critical: !!e.critical,
          created_date: e.created_date,
        })),
    };
  },

  /** Everything currently recoverable, with its purge deadline. */
  recovery_list: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "recover_deleted");
    const accessible = await accessibleLocationIds(ctx);
    const scoped = (locId?: string) => accessible === null || (!!locId && accessible.has(locId));

    const items = (await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000))
      .filter((i: any) => i.deleted_at && scoped(i.location_id));

    // Media/attachments inherit scope from their owning container or item.
    const containers = await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000);
    const containerById = new Map(containers.map((c: any) => [c.id, c]));
    const allItems = await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000);
    const itemById = new Map(allItems.map((i: any) => [i.id, i]));
    const ownerLocation = (ownerType: string, ownerId: string): string | undefined =>
      ownerType === "container" ? containerById.get(ownerId)?.location_id : itemById.get(ownerId)?.location_id;

    const media = (await ctx.sr.entities.MediaAsset.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000))
      .filter((m: any) => m.deleted_at && scoped(ownerLocation(m.owner_type, m.owner_id)));
    const attachments = (await ctx.sr.entities.Attachment.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000))
      .filter((a: any) => a.deleted_at && scoped(ownerLocation(a.owner_type, a.owner_id)));

    return {
      items: items.map((i: any) => ({
        id: i.id, name: i.name, container_id: i.container_id,
        deleted_at: i.deleted_at, purge_after: i.purge_after,
      })),
      media: media.map((m: any) => ({
        id: m.id, owner_type: m.owner_type, owner_id: m.owner_id,
        bytes_total: m.bytes_total ?? 0, deleted_at: m.deleted_at, purge_after: m.purge_after,
      })),
      attachments: attachments.map((a: any) => ({
        id: a.id, file_name: a.file_name, owner_type: a.owner_type, owner_id: a.owner_id,
        bytes: a.bytes ?? 0, deleted_at: a.deleted_at, purge_after: a.purge_after,
      })),
      note: "Deleted records stay recoverable for 30 days and keep counting toward storage until purged.",
    };
  },
});
