// api/items — item lifecycle and every manual entry method. Missing quantity
// is stored as null and never assumed to be 1. Household workspaces accept the
// simple + "More Details" fields; business-only fields are rejected there.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny } from "../../../shared/http.ts";
import { requireMember, requireLocationCap, accessibleLocationIds } from "../../../shared/authz.ts";
import { requireContainer, requireItem } from "../../../shared/inventory.ts";
import { logActivity } from "../../../shared/audit.ts";
import { buildSearchText } from "../../../shared/searchtext.ts";

const CORE_FIELDS = ["name", "quantity", "description", "category", "tags", "notes", "custom"] as const;
const DETAIL_FIELDS = ["condition", "purchase_date", "estimated_value", "expiration_date", "warranty_expires"] as const;
const BUSINESS_FIELDS = [
  "brand", "model", "serial_number", "purchase_price", "department", "internal_ref", "supplier",
] as const;

const RECOVERY_DAYS = 30;

function refreshSearchText(i: Record<string, any>): string {
  return buildSearchText([
    i.name, i.description, i.category, i.tags, i.notes, i.brand, i.model, i.serial_number,
  ]);
}

function publicItem(i: Record<string, any>) {
  const out: Record<string, unknown> = {
    id: i.id,
    container_id: i.container_id,
    location_id: i.location_id,
    name: i.name,
    quantity: i.quantity ?? null,
    description: i.description,
    category: i.category,
    tags: i.tags ?? [],
    notes: i.notes,
    state: i.state ?? "confirmed",
    origin: i.origin ?? "manual",
    archived: !!i.archived,
    deleted_at: i.deleted_at ?? null,
    custom: i.custom ?? {},
    created_date: i.created_date,
    updated_date: i.updated_date,
  };
  for (const f of [...DETAIL_FIELDS, ...BUSINESS_FIELDS]) if (i[f] !== undefined) out[f] = i[f];
  return out;
}

/** Copy allowed fields from payload into patch, enforcing the workspace-type field policy. */
function applyFieldPolicy(
  workspaceType: string,
  source: Record<string, any>,
  patch: Record<string, unknown>,
): void {
  for (const f of [...CORE_FIELDS, ...DETAIL_FIELDS, ...BUSINESS_FIELDS]) {
    if (!(f in source)) continue;
    if (workspaceType === "household" && (BUSINESS_FIELDS as readonly string[]).includes(f)) {
      throw badRequest(`Field "${f}" is only available in Business and Organization workspaces`);
    }
    patch[f] = source[f];
  }
  if ("name" in patch) {
    const name = typeof patch.name === "string" ? patch.name.trim().slice(0, 300) : "";
    if (!name) throw badRequest("Item name is required");
    patch.name = name;
  }
  if ("quantity" in patch && patch.quantity !== null) {
    const q = Number(patch.quantity);
    if (!Number.isFinite(q) || q < 0) throw badRequest("Quantity must be a non-negative number");
    patch.quantity = q;
  }
  if ("tags" in patch && !Array.isArray(patch.tags)) patch.tags = [];
}

async function createOne(
  ctx: Record<string, any>,
  container: Record<string, any>,
  fields: Record<string, any>,
  origin: string,
): Promise<Record<string, any>> {
  const patch: Record<string, unknown> = {};
  applyFieldPolicy(ctx.workspace.workspace_type, fields, patch);
  if (!patch.name) throw badRequest("Item name is required");
  const item = await ctx.sr.entities.Item.create({
    workspace_id: ctx.workspace.id,
    container_id: container.id,
    location_id: container.location_id,
    ...patch,
    state: "confirmed",
    origin,
    archived: false,
    client_uuid: typeof fields.client_uuid === "string" ? fields.client_uuid : undefined,
    updated_by_user_id: ctx.user.id,
  });
  return await ctx.sr.entities.Item.update(item.id, { search_text: refreshSearchText(item) });
}

serveActions({
  create_item: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const container = await requireContainer(ctx, payload.container_id, "create_inventory");
    if (container.archived) throw badRequest("Restore the container before adding items");
    const item = await createOne(ctx, container, payload, "manual");
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.created",
      target_type: "item", target_id: item.id, target_label: item.name,
    });
    return { item: publicItem(item) };
  },

  /** Every quick-list line becomes an individual item record; quantity stays unspecified. */
  quick_add: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const container = await requireContainer(ctx, payload.container_id, "create_inventory");
    if (container.archived) throw badRequest("Restore the container before adding items");

    const lines = (Array.isArray(payload.lines) ? payload.lines : String(payload.lines ?? "").split("\n"))
      .map((l) => String(l).trim())
      .filter(Boolean)
      .slice(0, 200);
    if (!lines.length) throw badRequest("No item lines provided");

    const items = [];
    for (const line of lines) {
      items.push(await createOne(ctx, container, { name: line }, "quicklist"));
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.quick_added",
      target_type: "container", target_id: container.id, metadata: { count: items.length },
    });
    return { items: items.map(publicItem) };
  },

  get_item: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const item = await requireItem(ctx, payload.item_id, "view");
    if (item.deleted_at) throw deny();
    return { item: publicItem(item) };
  },

  list_items: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const accessible = await accessibleLocationIds(ctx);

    const query: Record<string, unknown> = { workspace_id: ctx.workspace.id };
    if (typeof payload.container_id === "string" && payload.container_id) {
      await requireContainer(ctx, payload.container_id, "view");
      query.container_id = payload.container_id;
    } else if (typeof payload.location_id === "string" && payload.location_id) {
      await requireLocationCap(ctx, payload.location_id, "view");
      query.location_id = payload.location_id;
    }
    query.archived = payload.archived_filter === true;
    // Drafts are not inventory until confirmed; they surface via review flows.
    query.state = payload.state === "draft" ? "draft" : "confirmed";

    const items = await ctx.sr.entities.Item.filter(query, "-updated_date", 1000);
    const visible = items.filter((i: any) =>
      !i.deleted_at && (accessible === null || accessible.has(i.location_id))
    );
    return { items: visible.map(publicItem) };
  },

  update_item: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const item = await requireItem(ctx, payload.item_id, "edit_inventory");
    if (item.deleted_at) throw deny();
    if (item.archived) throw badRequest("Restore the item before editing");

    const patch: Record<string, unknown> = { updated_by_user_id: ctx.user.id };
    applyFieldPolicy(ctx.workspace.workspace_type, (payload.patch as Record<string, any>) ?? {}, patch);
    patch.search_text = refreshSearchText({ ...item, ...patch });
    const updated = await ctx.sr.entities.Item.update(item.id, patch);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.updated",
      target_type: "item", target_id: item.id, target_label: updated.name,
    });
    return { item: publicItem(updated) };
  },

  set_archived: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const item = await requireItem(ctx, payload.item_id, "archive_inventory");
    if (item.deleted_at) throw deny();
    const archived = payload.archived === true;
    await ctx.sr.entities.Item.update(item.id, {
      archived,
      archived_at: archived ? new Date().toISOString() : null,
      updated_by_user_id: ctx.user.id,
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user,
      action: archived ? "item.archived" : "item.restored",
      target_type: "item", target_id: item.id, target_label: item.name,
    });
    return { archived };
  },

  /** Bulk move whole items to another container (both ends must be editable). */
  move_items: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const dest = await requireContainer(ctx, payload.dest_container_id, "edit_inventory");
    if (dest.archived) throw badRequest("Cannot move items into an archived container");
    const ids = Array.isArray(payload.item_ids) ? payload.item_ids.slice(0, 500) : [];
    if (!ids.length) throw badRequest("item_ids required");

    const moved = [];
    for (const id of ids) {
      const item = await requireItem(ctx, id, "edit_inventory");
      if (item.deleted_at || item.archived) continue;
      moved.push(await ctx.sr.entities.Item.update(item.id, {
        container_id: dest.id, location_id: dest.location_id, updated_by_user_id: ctx.user.id,
      }));
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.bulk_moved",
      target_type: "container", target_id: dest.id, metadata: { count: moved.length },
    });
    return { moved: moved.length };
  },

  /** Move part of a quantity into a container; merges with a same-name item there. */
  split_item: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const item = await requireItem(ctx, payload.item_id, "edit_inventory");
    if (item.deleted_at || item.archived) throw deny();
    const dest = await requireContainer(ctx, payload.dest_container_id, "edit_inventory");
    if (dest.id === item.container_id) throw badRequest("Destination is the item's current container");
    if (dest.archived) throw badRequest("Cannot move items into an archived container");

    const qty = Number(payload.quantity_to_move);
    if (!Number.isFinite(qty) || qty <= 0) throw badRequest("quantity_to_move must be positive");
    if (item.quantity == null) throw badRequest("Set the item's quantity before splitting it");
    if (qty > item.quantity) throw badRequest("Cannot move more than the item's quantity");

    const siblings = await ctx.sr.entities.Item.filter({
      workspace_id: ctx.workspace.id, container_id: dest.id, name: item.name, archived: false,
    });
    const target = siblings.find((s: any) => !s.deleted_at && s.state === "confirmed");
    let destItem;
    if (target) {
      destItem = await ctx.sr.entities.Item.update(target.id, {
        quantity: (target.quantity ?? 0) + qty, updated_by_user_id: ctx.user.id,
      });
    } else {
      destItem = await createOne(ctx, dest, {
        name: item.name, quantity: qty, description: item.description,
        category: item.category, tags: item.tags, notes: item.notes,
      }, item.origin ?? "manual");
    }

    let source = null;
    if (qty === item.quantity) {
      await ctx.sr.entities.Item.update(item.id, {
        deleted_at: new Date().toISOString(),
        purge_after: new Date(Date.now() + RECOVERY_DAYS * 86400_000).toISOString(),
        updated_by_user_id: ctx.user.id,
      });
    } else {
      source = await ctx.sr.entities.Item.update(item.id, {
        quantity: item.quantity - qty, updated_by_user_id: ctx.user.id,
      });
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.split",
      target_type: "item", target_id: item.id, target_label: item.name,
      metadata: { moved_quantity: qty, dest_container_id: dest.id },
    });
    return { source: source ? publicItem(source) : null, dest_item: publicItem(destItem) };
  },

  copy_item: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const item = await requireItem(ctx, payload.item_id, "view");
    if (item.deleted_at) throw deny();
    const dest = await requireContainer(ctx, payload.dest_container_id, "create_inventory");
    if (dest.archived) throw badRequest("Cannot copy into an archived container");
    const fields: Record<string, any> = {};
    for (const f of [...CORE_FIELDS, ...DETAIL_FIELDS, ...BUSINESS_FIELDS]) {
      if (item[f] !== undefined) fields[f] = item[f];
    }
    const copy = await createOne(ctx, dest, fields, item.origin ?? "manual");
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.copied",
      target_type: "item", target_id: copy.id, target_label: copy.name,
    });
    return { item: publicItem(copy) };
  },

  /** Merge duplicates into one record. Quantities sum only when every record has one. */
  merge_items: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const keepId = payload.keep_item_id;
    const ids = (Array.isArray(payload.item_ids) ? payload.item_ids : []).filter((id) => id !== keepId);
    if (!ids.length) throw badRequest("item_ids must include at least one other item");
    const keep = await requireItem(ctx, keepId, "edit_inventory");
    if (keep.deleted_at || keep.archived) throw deny();

    const others = [];
    for (const id of ids.slice(0, 50)) {
      const it = await requireItem(ctx, id, "edit_inventory");
      if (!it.deleted_at && !it.archived) others.push(it);
    }
    const all = [keep, ...others];
    const quantities = all.map((i) => i.quantity);
    const quantity = quantities.every((q: unknown) => q != null)
      ? quantities.reduce((a: number, b: number) => a + b, 0)
      : keep.quantity ?? null;
    const tags = [...new Set(all.flatMap((i) => i.tags ?? []))];
    const pickFirst = (field: string) => all.map((i) => i[field]).find((v) => v != null && v !== "");

    const merged = await ctx.sr.entities.Item.update(keep.id, {
      quantity, tags,
      description: pickFirst("description"),
      category: pickFirst("category"),
      notes: pickFirst("notes"),
      updated_by_user_id: ctx.user.id,
    });
    for (const other of others) {
      await ctx.sr.entities.Item.update(other.id, {
        deleted_at: new Date().toISOString(),
        purge_after: new Date(Date.now() + RECOVERY_DAYS * 86400_000).toISOString(),
        updated_by_user_id: ctx.user.id,
      });
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.merged",
      target_type: "item", target_id: keep.id, target_label: keep.name,
      metadata: { merged_count: others.length },
    });
    return { item: publicItem({ ...merged, search_text: undefined }) };
  },

  /** Soft delete into the 30-day recovery area. */
  delete_item: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const item = await requireItem(ctx, payload.item_id, "archive_inventory");
    if (item.deleted_at) throw deny();
    await ctx.sr.entities.Item.update(item.id, {
      deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + RECOVERY_DAYS * 86400_000).toISOString(),
      updated_by_user_id: ctx.user.id,
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.deleted",
      target_type: "item", target_id: item.id, target_label: item.name,
    });
    return { deleted: true, recoverable_until: new Date(Date.now() + RECOVERY_DAYS * 86400_000).toISOString() };
  },

  list_deleted: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "recover_deleted");
    const accessible = await accessibleLocationIds(ctx);
    const items = await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000);
    const deleted = items.filter((i: any) =>
      i.deleted_at && (accessible === null || accessible.has(i.location_id))
    );
    return { items: deleted.map((i: any) => ({ ...publicItem(i), purge_after: i.purge_after })) };
  },

  restore_deleted: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "recover_deleted");
    const item = await requireItem(ctx, payload.item_id, "recover_deleted");
    if (!item.deleted_at) throw badRequest("Item is not deleted");
    const updated = await ctx.sr.entities.Item.update(item.id, {
      deleted_at: null, purge_after: null, updated_by_user_id: ctx.user.id,
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.recovered",
      target_type: "item", target_id: item.id, target_label: item.name,
    });
    return { item: publicItem(updated) };
  },
});
