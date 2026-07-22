// api/sync — offline synchronization for the mobile clients.
//
// pull: per-entity delta since cursors, strictly scoped to accessible
//       locations, plus the workspace's offline policy and the accessible-
//       location set so clients can prune cache that left their scope.
// push: idempotent mutation replay. Creates dedupe on client_uuid (numbers
//       are allocated server-side exactly once); updates use base_updated_date
//       for conflict detection. Destructive/ambiguous cases (quantity,
//       archive-vs-edit, concurrent moves) return BOTH versions for review
//       instead of silently overwriting.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny } from "../../../shared/http.ts";
import { requireMember, requireLocationCap, accessibleLocationIds, type AuthContext } from "../../../shared/authz.ts";
import { requireContainer, requireItem } from "../../../shared/inventory.ts";
import { logActivity } from "../../../shared/audit.ts";
import { assertWithinLimit } from "../../../shared/entitlements.ts";
import { allocateNumber, formatNumber } from "../../../shared/numbering.ts";
import { newQrToken } from "../../../shared/tokens.ts";
import { buildSearchText } from "../../../shared/searchtext.ts";

const PULL_LIMIT = 500;
const DEFAULT_POLICY = { photos_enabled: true, edits_enabled: true, biometric_required: false };

function offlinePolicy(workspace: Record<string, any>) {
  const configured = workspace.settings?.offline ?? {};
  const defaultDays = workspace.workspace_type === "household" ? 30 : 7;
  const mode = configured.mode ?? (workspace.workspace_type === "household" ? "30_days" : "7_days");
  const days = mode === "disabled" ? 0
    : mode === "daily" ? 1
    : mode === "7_days" ? 7
    : mode === "30_days" ? 30
    : mode === "custom" ? (configured.custom_revalidate_days ?? defaultDays)
    : defaultDays;
  return { ...DEFAULT_POLICY, ...configured, mode, revalidate_days: days };
}

/**
 * Delta rows for one entity, scoped and cursor-filtered. The platform can't
 * compare stored dates against ISO strings in a filter, so we fetch newest-
 * first and compare serialized ISO strings (lexicographically ordered) here.
 */
async function delta(
  ctx: AuthContext,
  entity: "Container" | "Item" | "Location",
  cursor: string | undefined,
  scoped: (locId: string) => boolean,
) {
  const rows = await ctx.sr.entities[entity].filter(
    { workspace_id: ctx.workspace.id }, "-updated_date", PULL_LIMIT,
  );
  const newer = rows
    .filter((r: any) => !cursor || (typeof r.updated_date === "string" && r.updated_date > cursor))
    .reverse();
  const visible = newer.filter((r: any) => entity === "Location" ? true : scoped(r.location_id));
  return {
    records: visible,
    cursor: newer.length ? newer[newer.length - 1].updated_date : cursor ?? null,
    // A full page of rows that are all newer than the cursor means older
    // unseen changes may have been cut off — the client should pull again.
    has_more: rows.length === PULL_LIMIT && newer.length === rows.length && !!cursor,
  };
}

serveActions({
  pull: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const accessible = await accessibleLocationIds(ctx);
    const scoped = (locId: string) => accessible === null || accessible.has(locId);
    const cursors = (payload.cursors ?? {}) as Record<string, string | undefined>;

    const [locations, containers, items] = await Promise.all([
      delta(ctx, "Location", cursors.locations, scoped),
      delta(ctx, "Container", cursors.containers, scoped),
      delta(ctx, "Item", cursors.items, scoped),
    ]);
    // Grant-scoped members only receive locations inside their scope.
    if (accessible !== null) {
      locations.records = locations.records.filter((l: any) => accessible.has(l.id));
    }

    return {
      server_time: new Date().toISOString(),
      policy: offlinePolicy(ctx.workspace),
      accessible_location_ids: accessible === null ? null : [...accessible],
      changes: { locations, containers, items },
    };
  },

  push: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const policy = offlinePolicy(ctx.workspace);
    if (policy.mode === "disabled" || policy.edits_enabled === false) {
      throw badRequest("Offline changes are disabled for this workspace");
    }
    const mutations = Array.isArray(payload.mutations) ? payload.mutations.slice(0, 100) : [];
    const results = [];

    for (const m of mutations) {
      const id = typeof m?.client_mutation_id === "string" ? m.client_mutation_id : crypto.randomUUID();
      try {
        results.push({ client_mutation_id: id, ...(await applyMutation(ctx, m)) });
      } catch (err: any) {
        results.push({
          client_mutation_id: id,
          status: "rejected",
          error: err?.code ?? "failed",
          message: err?.status === 400 ? err?.message : undefined,
        });
      }
    }
    return { server_time: new Date().toISOString(), results };
  },
});

async function applyMutation(ctx: AuthContext, m: Record<string, any>): Promise<Record<string, unknown>> {
  const p = m?.payload ?? {};
  switch (m?.kind) {
    case "create_container": {
      // Idempotent on client_uuid: a retried push returns the original record.
      if (typeof p.client_uuid !== "string" || !p.client_uuid) throw badRequest("client_uuid required");
      const existing = await ctx.sr.entities.Container.filter({
        workspace_id: ctx.workspace.id, client_uuid: p.client_uuid,
      });
      if (existing.length) return { status: "applied", kind: "container", record: existing[0] };

      const location = await requireLocationCap(ctx, p.location_id, "create_inventory");
      if (location.archived) throw badRequest("Location is archived");
      await assertWithinLimit(ctx.sr, ctx.workspace.id, "containers");
      const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
      if (!title) throw badRequest("Title required");

      const container = await ctx.sr.entities.Container.create({
        workspace_id: ctx.workspace.id,
        location_id: location.id,
        qr_token: newQrToken(),
        container_type: typeof p.container_type === "string" ? p.container_type : "bin",
        title,
        category: typeof p.category === "string" ? p.category : undefined,
        tags: Array.isArray(p.tags) ? p.tags : [],
        notes: typeof p.notes === "string" ? p.notes : undefined,
        label_status: "not_printed",
        archived: false,
        pending_number: true,
        client_uuid: p.client_uuid,
        updated_by_user_id: ctx.user.id,
      });
      const number = await allocateNumber(ctx.sr, ctx.workspace.id, container.id);
      const updated = await ctx.sr.entities.Container.update(container.id, {
        number, number_display: formatNumber(number), pending_number: false,
        search_text: buildSearchText([title, p.category, p.tags, formatNumber(number)]),
      });
      await logActivity(ctx.sr, {
        workspace_id: ctx.workspace.id, actor: ctx.user, action: "container.created",
        target_type: "container", target_id: container.id,
        target_label: `${formatNumber(number)} ${title}`, metadata: { via: "offline_sync" },
      });
      return { status: "applied", kind: "container", record: updated };
    }

    case "create_item": {
      if (typeof p.client_uuid !== "string" || !p.client_uuid) throw badRequest("client_uuid required");
      const existing = await ctx.sr.entities.Item.filter({
        workspace_id: ctx.workspace.id, client_uuid: p.client_uuid,
      });
      if (existing.length) return { status: "applied", kind: "item", record: existing[0] };

      // Offline-created containers: the item may reference the container's
      // client_uuid instead of a server id.
      let containerId = typeof p.container_id === "string" ? p.container_id : "";
      if (!containerId && typeof p.container_client_uuid === "string") {
        const parents = await ctx.sr.entities.Container.filter({
          workspace_id: ctx.workspace.id, client_uuid: p.container_client_uuid,
        });
        if (!parents.length) throw badRequest("Parent container not synced yet");
        containerId = parents[0].id;
      }
      const container = await requireContainer(ctx, containerId, "create_inventory");
      const name = typeof p.name === "string" ? p.name.trim().slice(0, 300) : "";
      if (!name) throw badRequest("Name required");
      const item = await ctx.sr.entities.Item.create({
        workspace_id: ctx.workspace.id,
        container_id: container.id,
        location_id: container.location_id,
        name,
        quantity: Number.isFinite(p.quantity) && p.quantity >= 0 ? p.quantity : undefined,
        category: typeof p.category === "string" ? p.category : undefined,
        tags: Array.isArray(p.tags) ? p.tags : [],
        notes: typeof p.notes === "string" ? p.notes : undefined,
        state: "confirmed",
        origin: typeof p.origin === "string" && ["manual", "quicklist"].includes(p.origin) ? p.origin : "manual",
        archived: false,
        client_uuid: p.client_uuid,
        search_text: buildSearchText([name, p.category, p.tags]),
        updated_by_user_id: ctx.user.id,
      });
      return { status: "applied", kind: "item", record: item };
    }

    case "update_item": {
      const item = await requireItem(ctx, p.item_id, "edit_inventory");
      if (item.deleted_at) throw deny();
      const patch = (p.patch ?? {}) as Record<string, any>;
      const stale = typeof p.base_updated_date === "string" && item.updated_date > p.base_updated_date;

      // Review required: quantity movement on a record someone else changed,
      // or any edit against an archived record (archive-vs-edit).
      if (item.archived) {
        return { status: "conflict", kind: "item", reason: "archived_vs_edit", server_record: item, client_payload: p };
      }
      if (stale && "quantity" in patch && patch.quantity !== item.quantity) {
        return { status: "conflict", kind: "item", reason: "quantity", server_record: item, client_payload: p };
      }
      const safe: Record<string, unknown> = { updated_by_user_id: ctx.user.id };
      for (const f of ["name", "quantity", "description", "category", "tags", "notes"]) {
        if (f in patch) safe[f] = patch[f];
      }
      if (typeof safe.name === "string" && !(safe.name as string).trim()) delete safe.name;
      safe.search_text = buildSearchText([
        (safe.name as string) ?? item.name, (safe.category as string) ?? item.category,
        (safe.tags as string[]) ?? item.tags, (safe.notes as string) ?? item.notes,
      ]);
      const updated = await ctx.sr.entities.Item.update(item.id, safe);
      return { status: "applied", kind: "item", record: updated };
    }

    case "delete_item": {
      const item = await requireItem(ctx, p.item_id, "archive_inventory");
      if (item.deleted_at) return { status: "applied", kind: "item", record: item };
      const stale = typeof p.base_updated_date === "string" && item.updated_date > p.base_updated_date;
      if (stale) {
        return { status: "conflict", kind: "item", reason: "delete_vs_edit", server_record: item, client_payload: p };
      }
      const updated = await ctx.sr.entities.Item.update(item.id, {
        deleted_at: new Date().toISOString(),
        purge_after: new Date(Date.now() + 30 * 86400_000).toISOString(),
        updated_by_user_id: ctx.user.id,
      });
      return { status: "applied", kind: "item", record: updated };
    }

    case "update_container": {
      const container = await requireContainer(ctx, p.container_id, "edit_inventory");
      const patch = (p.patch ?? {}) as Record<string, any>;
      if (container.archived) {
        return { status: "conflict", kind: "container", reason: "archived_vs_edit", server_record: container, client_payload: p };
      }
      const safe: Record<string, unknown> = { updated_by_user_id: ctx.user.id };
      for (const f of ["title", "description", "category", "tags", "notes", "container_color", "lid_color"]) {
        if (f in patch) safe[f] = patch[f];
      }
      if (typeof safe.title === "string" && !(safe.title as string).trim()) delete safe.title;
      safe.search_text = buildSearchText([
        (safe.title as string) ?? container.title, (safe.category as string) ?? container.category,
        (safe.tags as string[]) ?? container.tags, (safe.notes as string) ?? container.notes,
        container.number ? formatNumber(container.number) : null,
      ]);
      const updated = await ctx.sr.entities.Container.update(container.id, safe);
      return { status: "applied", kind: "container", record: updated };
    }

    case "move_container": {
      const container = await requireContainer(ctx, p.container_id, "move_inventory");
      // Incompatible move: it moved somewhere else since the client last saw it.
      if (typeof p.base_location_id === "string" && container.location_id !== p.base_location_id) {
        return { status: "conflict", kind: "container", reason: "incompatible_move", server_record: container, client_payload: p };
      }
      const dest = await requireLocationCap(ctx, p.new_location_id, "move_inventory");
      if (dest.archived) throw badRequest("Destination archived");
      const updated = await ctx.sr.entities.Container.update(container.id, {
        location_id: dest.id, updated_by_user_id: ctx.user.id,
      });
      const items = await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id, container_id: container.id });
      for (const item of items) await ctx.sr.entities.Item.update(item.id, { location_id: dest.id });
      await logActivity(ctx.sr, {
        workspace_id: ctx.workspace.id, actor: ctx.user, action: "container.moved",
        target_type: "container", target_id: container.id, metadata: { via: "offline_sync" },
      });
      return { status: "applied", kind: "container", record: updated };
    }

    default:
      throw badRequest(`Unknown mutation kind: ${String(m?.kind)}`);
  }
}
