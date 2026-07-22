// api/qr — secure QR resolution. The scan flow's single backend step:
// authenticate → find token → check membership + location grant → payload.
// Unknown tokens and unauthorized tokens return the identical generic 404;
// unauthenticated calls return a bare 401 so clients can round-trip login
// while preserving the destination. Nothing about hidden containers,
// workspaces, or their existence ever leaves this function.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, deny, unauthorized } from "../../../shared/http.ts";
import { requireLocationCap, roleCan, hasAllLocations, type AuthContext } from "../../../shared/authz.ts";
import { formatNumber } from "../../../shared/numbering.ts";

serveActions({
  resolve: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) throw unauthorized();
    const sr = base44.asServiceRole;

    const token = typeof payload.qr_token === "string" ? payload.qr_token.trim() : "";
    if (!token || token.length > 64) throw deny();

    const matches = await sr.entities.Container.filter({ qr_token: token });
    const container = matches[0];
    if (!container) throw deny();

    const members = await sr.entities.WorkspaceMember.filter({
      workspace_id: container.workspace_id, user_id: user.id, status: "active",
    });
    if (!members.length) throw deny();
    const workspace = await sr.entities.Workspace.get(container.workspace_id).catch(() => null);
    if (!workspace) throw deny();
    const ctx: AuthContext = { user, workspace, member: members[0], sr };

    const location = await requireLocationCap(ctx, container.location_id, "view");

    const base = {
      workspace: { id: workspace.id, name: workspace.name, workspace_type: workspace.workspace_type },
      container: {
        id: container.id,
        number_display: container.number ? formatNumber(container.number) : null,
        container_type: container.container_type,
        custom_type_label: container.custom_type_label,
        title: container.title,
        description: container.description,
        category: container.category,
        tags: container.tags ?? [],
        notes: container.notes,
        label_status: container.label_status,
        location_id: location.id,
        location_path: location.path_text,
      },
      my_role: ctx.member.member_role,
    };

    if (container.archived) {
      const canRestore = hasAllLocations(ctx)
        ? roleCan(ctx.member.member_role, "archive_inventory")
        : await requireLocationCap(ctx, container.location_id, "archive_inventory").then(() => true, () => false);
      return { state: "archived", ...base, archived_at: container.archived_at, can_restore: canRestore };
    }

    const items = await sr.entities.Item.filter(
      { workspace_id: workspace.id, container_id: container.id, archived: false },
      "-updated_date",
      200,
    );
    const media = await sr.entities.MediaAsset.filter({
      workspace_id: workspace.id, owner_type: "container", owner_id: container.id,
    });
    return {
      state: "active",
      ...base,
      items: items
        .filter((i: any) => !i.deleted_at && i.state === "confirmed")
        .map((i: any) => ({
          id: i.id, name: i.name, quantity: i.quantity ?? null,
          category: i.category, tags: i.tags ?? [],
        })),
      media_ids: media.filter((m: any) => !m.deleted_at).map((m: any) => m.id),
    };
  },
});
