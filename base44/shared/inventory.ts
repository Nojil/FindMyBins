// Authorization-aware record resolution for inventory objects. Always resolves
// through the owning location so grant scoping applies, and always answers
// missing and unauthorized identically.

import { deny } from "./http.ts";
import { requireLocationCap, type AuthContext, type Capability } from "./authz.ts";

export async function requireContainer(
  ctx: AuthContext,
  containerId: unknown,
  cap: Capability,
): Promise<Record<string, any>> {
  if (typeof containerId !== "string" || !containerId) throw deny();
  const container = await ctx.sr.entities.Container.get(containerId).catch(() => null);
  if (!container || container.workspace_id !== ctx.workspace.id) throw deny();
  await requireLocationCap(ctx, container.location_id, cap);
  return container;
}

export async function requireItem(
  ctx: AuthContext,
  itemId: unknown,
  cap: Capability,
): Promise<Record<string, any>> {
  if (typeof itemId !== "string" || !itemId) throw deny();
  const item = await ctx.sr.entities.Item.get(itemId).catch(() => null);
  if (!item || item.workspace_id !== ctx.workspace.id) throw deny();
  await requireLocationCap(ctx, item.location_id, cap);
  return item;
}
