// Single enforcement point for workspace membership, roles, and location grants.
// Every API function must authorize through this module BEFORE any data retrieval.
// Client-supplied workspace/location/role IDs are only ever used as lookup keys here.

import { deny, forbidden, unauthorized } from "./http.ts";

export type MemberRole = "owner" | "admin" | "manager" | "contributor" | "viewer" | "billing_admin";
export type GrantRole = "manager" | "contributor" | "viewer";

export type Capability =
  | "view"
  | "create_inventory"
  | "edit_inventory"
  | "archive_inventory"
  | "move_inventory"
  | "manage_locations"
  | "print_labels"
  | "edit_numbers"
  | "manage_fields"
  | "manage_members"
  | "import"
  | "export"
  | "reports"
  | "view_activity"
  | "workspace_settings"
  | "billing"
  | "transfer_ownership"
  | "delete_workspace"
  | "recover_deleted";

const MANAGER_CAPS: Capability[] = [
  "view", "create_inventory", "edit_inventory", "archive_inventory", "move_inventory",
  "manage_locations", "print_labels", "export", "reports", "view_activity", "recover_deleted",
];
const CONTRIBUTOR_CAPS: Capability[] = ["view", "create_inventory", "edit_inventory", "print_labels"];
const ADMIN_CAPS: Capability[] = [
  ...MANAGER_CAPS, "edit_numbers", "manage_fields", "manage_members", "import", "workspace_settings",
];

const ROLE_CAPS: Record<MemberRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([...ADMIN_CAPS, "billing", "transfer_ownership", "delete_workspace"]),
  admin: new Set(ADMIN_CAPS),
  manager: new Set(MANAGER_CAPS),
  contributor: new Set(CONTRIBUTOR_CAPS),
  viewer: new Set<Capability>(["view"]),
  billing_admin: new Set<Capability>(["billing"]),
};

/** Grant roles reuse the workspace tables, minus workspace-wide capabilities. */
const GRANT_CAPS: Record<GrantRole, ReadonlySet<Capability>> = {
  manager: new Set(MANAGER_CAPS),
  contributor: new Set(CONTRIBUTOR_CAPS),
  viewer: new Set<Capability>(["view"]),
};

export function roleCan(role: MemberRole, cap: Capability): boolean {
  return ROLE_CAPS[role]?.has(cap) ?? false;
}

export interface AuthContext {
  user: { id: string; email: string };
  workspace: Record<string, any>;
  member: Record<string, any>;
  /** Service-role handle — use ONLY with workspace/location-scoped filters. */
  sr: any;
}

export async function requireUser(base44: any): Promise<{ id: string; email: string }> {
  // auth.me() throws (rather than returning null) when the request carries no
  // valid user token — normalize both shapes to a clean 401.
  const user = await base44.auth.me().catch(() => null);
  if (!user) throw unauthorized();
  return user;
}

/**
 * Resolve the caller's active membership in a workspace, optionally requiring a
 * workspace-level capability. Missing workspace and missing membership are the
 * same generic denial.
 */
export async function requireMember(
  base44: any,
  workspaceId: unknown,
  cap?: Capability,
): Promise<AuthContext> {
  const user = await requireUser(base44);
  if (typeof workspaceId !== "string" || !workspaceId) throw deny();
  const sr = base44.asServiceRole;

  const members = await sr.entities.WorkspaceMember.filter({
    workspace_id: workspaceId,
    user_id: user.id,
    status: "active",
  });
  if (!members.length) throw deny();
  const member = members[0];

  const workspace = await sr.entities.Workspace.get(workspaceId).catch(() => null);
  if (!workspace || workspace.status === "pending_deletion" && member.member_role !== "owner") {
    throw deny();
  }
  if (cap && !roleCan(member.member_role as MemberRole, cap)) throw forbidden();

  return { user, workspace, member, sr };
}

/** True when the member's access is workspace-wide rather than grant-scoped. */
export function hasAllLocations(ctx: AuthContext): boolean {
  if (ctx.member.member_role === "owner" || ctx.member.member_role === "admin") return true;
  // Location-based permissions only apply to Business/Organization workspaces.
  if (ctx.workspace.workspace_type === "household") {
    return ctx.member.member_role !== "billing_admin";
  }
  return false;
}

/**
 * The set of location IDs this member may access, or null meaning "all".
 * A grant on a location covers that location and every descendant (path_ids).
 */
export async function accessibleLocationIds(ctx: AuthContext): Promise<Set<string> | null> {
  if (hasAllLocations(ctx)) return null;
  const grants = await ctx.sr.entities.LocationGrant.filter({
    workspace_id: ctx.workspace.id,
    member_id: ctx.member.id,
  });
  if (!grants.length) return new Set();
  const grantedIds = grants.map((g: any) => g.location_id);
  const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
  const accessible = new Set<string>();
  for (const loc of locations) {
    if (grantedIds.includes(loc.id) || (loc.path_ids ?? []).some((p: string) => grantedIds.includes(p))) {
      accessible.add(loc.id);
    }
  }
  return accessible;
}

/**
 * The member's effective capability set at a specific location. Workspace-wide
 * members use their workspace role; grant-scoped members use the strongest
 * grant covering the location or any ancestor. Throws the generic denial when
 * the location is out of scope or does not exist.
 */
export async function requireLocationCap(
  ctx: AuthContext,
  locationId: unknown,
  cap: Capability,
): Promise<Record<string, any>> {
  if (typeof locationId !== "string" || !locationId) throw deny();
  const location = await ctx.sr.entities.Location.get(locationId).catch(() => null);
  if (!location || location.workspace_id !== ctx.workspace.id) throw deny();

  if (hasAllLocations(ctx)) {
    if (!roleCan(ctx.member.member_role as MemberRole, cap)) throw forbidden();
    return location;
  }

  const grants = await ctx.sr.entities.LocationGrant.filter({
    workspace_id: ctx.workspace.id,
    member_id: ctx.member.id,
  });
  const covering = grants.filter((g: any) =>
    g.location_id === locationId || (location.path_ids ?? []).includes(g.location_id)
  );
  if (!covering.length) throw deny();
  const allowed = covering.some((g: any) => GRANT_CAPS[g.grant_role as GrantRole]?.has(cap));
  if (!allowed) throw forbidden();
  return location;
}
