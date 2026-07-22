// api/locations — flexible location hierarchy with denormalized paths.
// Grant-scoped members only see and manage locations covered by their grants.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny, forbidden } from "../../../shared/http.ts";
import { requireMember, requireLocationCap, accessibleLocationIds, hasAllLocations, roleCan } from "../../../shared/authz.ts";
import { logActivity } from "../../../shared/audit.ts";
import { assertWithinLimit } from "../../../shared/entitlements.ts";

const SEP = " › ";

function publicLocation(l: Record<string, any>) {
  return {
    id: l.id,
    parent_id: l.parent_id ?? null,
    name: l.name,
    level: l.level ?? 0,
    path_ids: l.path_ids ?? [],
    path_text: l.path_text ?? l.name,
    sort_order: l.sort_order ?? 0,
    archived: !!l.archived,
  };
}

/** Recompute path_ids/path_text/level for a location subtree after rename or move. */
async function recomputeSubtree(sr: any, workspaceId: string, rootId: string): Promise<void> {
  const all = await sr.entities.Location.filter({ workspace_id: workspaceId });
  const byId = new Map(all.map((l: any) => [l.id, l]));
  const children = new Map<string | null, any[]>();
  for (const l of all) {
    const key = l.parent_id ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(l);
  }
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const loc = byId.get(id);
    if (!loc) continue;
    const parent = loc.parent_id ? byId.get(loc.parent_id) : null;
    const path_ids = parent ? [...(parent.path_ids ?? []), parent.id] : [];
    const path_text = parent ? `${parent.path_text}${SEP}${loc.name}` : loc.name;
    const level = path_ids.length;
    await sr.entities.Location.update(id, { path_ids, path_text, level });
    loc.path_ids = path_ids;
    loc.path_text = path_text;
    loc.level = level;
    for (const child of children.get(id) ?? []) queue.push(child.id);
  }
}

serveActions({
  list_locations: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const accessible = await accessibleLocationIds(ctx);
    const all = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const visible = accessible === null ? all : all.filter((l: any) => accessible.has(l.id));
    const includeArchived = payload.include_archived === true;
    return {
      locations: visible
        .filter((l: any) => includeArchived || !l.archived)
        .map(publicLocation)
        .sort((a: any, b: any) => a.path_text.localeCompare(b.path_text)),
    };
  },

  create_location: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "";
    if (!name) throw badRequest("Location name is required");

    const parentId = typeof payload.parent_id === "string" && payload.parent_id ? payload.parent_id : null;
    let parent: Record<string, any> | null = null;
    if (parentId) {
      parent = await requireLocationCap(ctx, parentId, "manage_locations");
    } else {
      // Root locations require workspace-wide manage_locations (owner/admin,
      // or any manager in a household workspace).
      if (!hasAllLocations(ctx) || !roleCan(ctx.member.member_role, "manage_locations")) throw forbidden();
    }
    await assertWithinLimit(ctx.sr, ctx.workspace.id, "locations");

    const location = await ctx.sr.entities.Location.create({
      workspace_id: ctx.workspace.id,
      parent_id: parentId ?? undefined,
      name,
      level: parent ? (parent.level ?? 0) + 1 : 0,
      path_ids: parent ? [...(parent.path_ids ?? []), parent.id] : [],
      path_text: parent ? `${parent.path_text}${SEP}${name}` : name,
      sort_order: Number(payload.sort_order) || 0,
      archived: false,
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "location.created",
      target_type: "location", target_id: location.id, target_label: location.path_text,
    });
    return { location: publicLocation(location) };
  },

  rename_location: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const location = await requireLocationCap(ctx, payload.location_id, "manage_locations");
    const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "";
    if (!name) throw badRequest("Location name is required");
    await ctx.sr.entities.Location.update(location.id, { name });
    await recomputeSubtree(ctx.sr, ctx.workspace.id, location.id);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "location.renamed",
      target_type: "location", target_id: location.id, metadata: { from: location.name, to: name },
    });
    const updated = await ctx.sr.entities.Location.get(location.id);
    return { location: publicLocation(updated) };
  },

  /** Move a location (and its subtree) under a new parent. Cycles are impossible by check. */
  move_location: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const location = await requireLocationCap(ctx, payload.location_id, "manage_locations");

    const newParentId = typeof payload.new_parent_id === "string" && payload.new_parent_id ? payload.new_parent_id : null;
    if (newParentId) {
      const newParent = await requireLocationCap(ctx, newParentId, "manage_locations");
      if (newParent.id === location.id || (newParent.path_ids ?? []).includes(location.id)) {
        throw badRequest("Cannot move a location into itself or its own descendants");
      }
    } else if (!hasAllLocations(ctx) || !roleCan(ctx.member.member_role, "manage_locations")) {
      throw forbidden();
    }

    await ctx.sr.entities.Location.update(location.id, { parent_id: newParentId ?? null });
    await recomputeSubtree(ctx.sr, ctx.workspace.id, location.id);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "location.moved",
      target_type: "location", target_id: location.id,
    });
    const updated = await ctx.sr.entities.Location.get(location.id);
    return { location: publicLocation(updated) };
  },

  set_archived: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const location = await requireLocationCap(ctx, payload.location_id, "manage_locations");
    const archived = payload.archived === true;
    if (archived) {
      const activeContainers = await ctx.sr.entities.Container.filter({
        workspace_id: ctx.workspace.id, location_id: location.id, archived: false,
      });
      if (activeContainers.length) throw badRequest("Move or archive this location's containers first");
      const all = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id, archived: false });
      const activeChildren = all.filter((l: any) => (l.path_ids ?? []).includes(location.id));
      if (activeChildren.length) throw badRequest("Archive or move sub-locations first");
    }
    await ctx.sr.entities.Location.update(location.id, { archived });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user,
      action: archived ? "location.archived" : "location.restored",
      target_type: "location", target_id: location.id, target_label: location.path_text,
    });
    return { archived };
  },
});
