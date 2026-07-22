// maintenance-sweep — the data-lifecycle janitor. Plain HTTP function so a
// dashboard Workflow can schedule it daily (this app has Workflows enabled,
// which disables file-based cron automations).
//
// Responsibilities:
//   1. Purge soft-deleted items/media/attachments past their 30-day window,
//      releasing the storage they were still counting against.
//   2. Prune activity events past the plan's retention window — never touching
//      critical security/ownership/permission/subscription/deletion events.
//   3. Expire stale capture sessions (failed voice/photo recovery windows).
//   4. Permanently delete workspaces whose 30-day deletion window has passed.
//
// Every step is bounded per run so the function stays well under the 5-minute
// execution limit; whatever is left over is picked up by the next run.

import { createClientFromRequest } from "npm:@base44/sdk";
import { adjustStorageUsed, getSubscription, effectivePlan } from "../../shared/entitlements.ts";

const BATCH = 200;
const RETENTION_DAYS: Record<string, number> = { free: 30, household: 365, business: 1095 };

/** Entities removed when a workspace is permanently deleted. */
const WORKSPACE_SCOPED = [
  "Item", "Container", "Location", "NumberReservation", "MediaAsset", "Attachment",
  "CaptureSession", "CustomFieldDef", "LocationGrant", "WorkspaceMember", "Invitation",
  "JoinRequest", "SearchHistory", "Job", "Notification", "NotificationPref",
  "ActivityEvent", "WorkspaceSubscription",
];

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const nowIso = new Date().toISOString();
  const stats = {
    items_purged: 0, media_purged: 0, attachments_purged: 0,
    activity_pruned: 0, sessions_expired: 0, workspaces_deleted: 0, bytes_released: 0,
  };

  // 1. Purge expired soft deletes.
  const expiredItems = (await sr.entities.Item.filter({}, "purge_after", BATCH))
    .filter((i: any) => i.deleted_at && i.purge_after && i.purge_after < nowIso);
  for (const item of expiredItems) {
    await sr.entities.Item.delete(item.id);
    stats.items_purged++;
  }

  const expiredMedia = (await sr.entities.MediaAsset.filter({}, "purge_after", BATCH))
    .filter((m: any) => m.deleted_at && m.purge_after && m.purge_after < nowIso);
  for (const media of expiredMedia) {
    await sr.entities.MediaAsset.delete(media.id);
    await adjustStorageUsed(sr, media.workspace_id, -(media.bytes_total ?? 0));
    stats.bytes_released += media.bytes_total ?? 0;
    stats.media_purged++;
  }

  const expiredAttachments = (await sr.entities.Attachment.filter({}, "purge_after", BATCH))
    .filter((a: any) => a.deleted_at && a.purge_after && a.purge_after < nowIso);
  for (const attachment of expiredAttachments) {
    await sr.entities.Attachment.delete(attachment.id);
    await adjustStorageUsed(sr, attachment.workspace_id, -(attachment.bytes ?? 0));
    stats.bytes_released += attachment.bytes ?? 0;
    stats.attachments_purged++;
  }

  // 2. Activity retention, per workspace plan. Critical events are never pruned.
  const workspaces = await sr.entities.Workspace.filter({}, "-updated_date", 200);
  for (const workspace of workspaces) {
    const sub = await getSubscription(sr, workspace.id);
    const days = RETENTION_DAYS[effectivePlan(sub)] ?? 30;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const stale = (await sr.entities.ActivityEvent.filter({ workspace_id: workspace.id }, "created_date", BATCH))
      .filter((e: any) => !e.critical && e.created_date < cutoff);
    for (const event of stale) {
      await sr.entities.ActivityEvent.delete(event.id);
      stats.activity_pruned++;
    }
  }

  // 3. Expire stale capture sessions; drop any lingering audio reference.
  const staleSessions = (await sr.entities.CaptureSession.filter({}, "expires_at", BATCH))
    .filter((s: any) => s.expires_at && s.expires_at < nowIso && s.status !== "expired");
  for (const session of staleSessions) {
    await sr.entities.CaptureSession.update(session.id, {
      status: "expired", audio_file_uri: null,
      audio_deleted_at: session.audio_deleted_at ?? nowIso,
    });
    stats.sessions_expired++;
  }

  // 4. Permanent workspace deletion after the recovery window.
  const doomed = workspaces.filter((w: any) =>
    w.status === "pending_deletion" && w.deletion_effective_at && w.deletion_effective_at < nowIso);
  for (const workspace of doomed) {
    for (const entity of WORKSPACE_SCOPED) {
      const records = await sr.entities[entity].filter({ workspace_id: workspace.id }, "-created_date", 1000);
      for (const record of records) {
        await sr.entities[entity].delete(record.id).catch(() => {});
      }
    }
    await sr.entities.Workspace.delete(workspace.id).catch(() => {});
    stats.workspaces_deleted++;
  }

  return Response.json({ ok: true, ...stats });
});
