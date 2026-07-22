// api/files — photo media registration and authorized access.
// Clients upload variants to PRIVATE storage via the SDK's UploadPrivateFile,
// then register them here; the server enforces location authorization and the
// storage quota, and is the only issuer of (short-lived) signed URLs — so
// removing access also kills file access. Deleted media stays recoverable for
// 30 days and keeps counting toward storage until purged.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny, safeError } from "../../../shared/http.ts";
import { requireMember } from "../../../shared/authz.ts";
import { requireContainer, requireItem } from "../../../shared/inventory.ts";
import { logActivity } from "../../../shared/audit.ts";
import { assertStorageAvailable, adjustStorageUsed } from "../../../shared/entitlements.ts";

const RECOVERY_DAYS = 30;
const SIGNED_URL_SECONDS = 600;
const VARIANTS = ["thumb", "medium", "full", "original"] as const;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ALLOWED_ATTACHMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  ...ALLOWED_IMAGE_TYPES,
];

function publicAttachment(a: Record<string, any>) {
  return {
    id: a.id,
    owner_type: a.owner_type,
    owner_id: a.owner_id,
    file_name: a.file_name,
    content_type: a.content_type,
    bytes: a.bytes ?? 0,
    description: a.description,
    version: a.version ?? 1,
    created_date: a.created_date,
  };
}

/** Resolve the media's owner record with the needed capability, or deny generically. */
async function requireMediaOwner(
  ctx: Record<string, any>,
  ownerType: string,
  ownerId: unknown,
  cap: "view" | "edit_inventory" | "archive_inventory" | "recover_deleted",
): Promise<void> {
  if (ownerType === "container") await requireContainer(ctx, ownerId, cap);
  else if (ownerType === "item") await requireItem(ctx, ownerId, cap);
  else throw badRequest("owner_type must be container or item");
}

function publicMedia(m: Record<string, any>) {
  return {
    id: m.id,
    owner_type: m.owner_type,
    owner_id: m.owner_id,
    content_type: m.content_type,
    bytes_total: m.bytes_total ?? 0,
    variants: Object.keys(m.file_uris ?? {}),
    deleted_at: m.deleted_at ?? null,
    created_date: m.created_date,
  };
}

serveActions({
  /** Register uploaded variant files as one photo. Quota is enforced here. */
  register_media: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ownerType = String(payload.owner_type ?? "");
    await requireMediaOwner(ctx, ownerType, payload.owner_id, "edit_inventory");

    const contentType = String(payload.content_type ?? "");
    if (!ALLOWED_IMAGE_TYPES.includes(contentType)) throw badRequest("Unsupported image type");
    const uris = (payload.file_uris ?? {}) as Record<string, unknown>;
    const fileUris: Record<string, string> = {};
    for (const v of VARIANTS) {
      if (typeof uris[v] === "string" && uris[v]) fileUris[v] = uris[v] as string;
    }
    if (!fileUris.full && !fileUris.medium) throw badRequest("At least a full or medium variant is required");
    const bytes = Number(payload.bytes_total);
    if (!Number.isFinite(bytes) || bytes <= 0) throw badRequest("bytes_total required");
    await assertStorageAvailable(ctx.sr, ctx.workspace.id, bytes);

    const media = await ctx.sr.entities.MediaAsset.create({
      workspace_id: ctx.workspace.id,
      owner_type: ownerType,
      owner_id: payload.owner_id,
      file_uris: fileUris,
      content_type: contentType,
      bytes_total: bytes,
      original_retained: !!fileUris.original,
      upload_state: "uploaded",
      client_uuid: typeof payload.client_uuid === "string" ? payload.client_uuid : undefined,
      uploaded_by_user_id: ctx.user.id,
    });
    await adjustStorageUsed(ctx.sr, ctx.workspace.id, bytes);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "media.added",
      target_type: ownerType, target_id: String(payload.owner_id),
    });
    return { media: publicMedia(media) };
  },

  list_media: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ownerType = String(payload.owner_type ?? "");
    await requireMediaOwner(ctx, ownerType, payload.owner_id, "view");
    const media = await ctx.sr.entities.MediaAsset.filter({
      workspace_id: ctx.workspace.id, owner_type: ownerType, owner_id: payload.owner_id,
    });
    return { media: media.filter((m: any) => !m.deleted_at).map(publicMedia) };
  },

  /** The only path to file bytes: authorize per asset, then mint short-lived URLs. */
  get_media_urls: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ids = Array.isArray(payload.media_ids) ? payload.media_ids.slice(0, 100) : [];
    const variant = VARIANTS.includes(payload.variant as any) ? (payload.variant as string) : "medium";

    const urls: Record<string, string> = {};
    for (const id of ids) {
      const media = await ctx.sr.entities.MediaAsset.get(id).catch(() => null);
      if (!media || media.workspace_id !== ctx.workspace.id || media.deleted_at) continue;
      const allowed = await requireMediaOwner(ctx, media.owner_type, media.owner_id, "view")
        .then(() => true, () => false);
      if (!allowed) continue;
      const uri = media.file_uris?.[variant] ?? media.file_uris?.full ?? media.file_uris?.medium;
      if (!uri) continue;
      try {
        const { signed_url } = await ctx.sr.integrations.Core.CreateFileSignedUrl({
          file_uri: uri, expires_in: SIGNED_URL_SECONDS,
        });
        urls[id] = signed_url;
      } catch (err) {
        console.error("[files] signed url failed for media", id, safeError(err));
      }
    }
    return { urls, expires_in: SIGNED_URL_SECONDS };
  },

  /** Attach a document (PDF/Word/Excel/CSV/text/images). Validated + quota-checked. */
  register_attachment: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ownerType = String(payload.owner_type ?? "");
    await requireMediaOwner(ctx, ownerType, payload.owner_id, "edit_inventory");

    const contentType = String(payload.content_type ?? "");
    if (!ALLOWED_ATTACHMENT_TYPES.includes(contentType)) {
      throw badRequest("Unsupported file type. Allowed: PDF, Word, Excel, CSV, text, and images.");
    }
    const fileName = String(payload.file_name ?? "").trim().slice(0, 255);
    const fileUri = String(payload.file_uri ?? "");
    const bytes = Number(payload.bytes);
    if (!fileName || !fileUri) throw badRequest("file_name and file_uri required");
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 25 * 1024 * 1024) {
      throw badRequest("Attachments are limited to 25 MB");
    }
    await assertStorageAvailable(ctx.sr, ctx.workspace.id, bytes);

    const attachment = await ctx.sr.entities.Attachment.create({
      workspace_id: ctx.workspace.id,
      owner_type: ownerType,
      owner_id: payload.owner_id,
      file_uri: fileUri,
      file_name: fileName,
      content_type: contentType,
      bytes,
      description: typeof payload.description === "string" ? payload.description : undefined,
      version: 1,
      previous_versions: [],
      archived: false,
      uploaded_by_user_id: ctx.user.id,
    });
    await adjustStorageUsed(ctx.sr, ctx.workspace.id, bytes);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "attachment.added",
      target_type: ownerType, target_id: String(payload.owner_id), target_label: fileName,
    });
    return { attachment: publicAttachment(attachment) };
  },

  list_attachments: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ownerType = String(payload.owner_type ?? "");
    await requireMediaOwner(ctx, ownerType, payload.owner_id, "view");
    const attachments = await ctx.sr.entities.Attachment.filter({
      workspace_id: ctx.workspace.id, owner_type: ownerType, owner_id: payload.owner_id,
    });
    return {
      attachments: attachments
        .filter((a: any) => !a.deleted_at && !a.archived)
        .map(publicAttachment),
    };
  },

  /** Access dies with permission: URLs are minted per-request after authz. */
  get_attachment_url: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const attachment = await ctx.sr.entities.Attachment.get(payload.attachment_id).catch(() => null);
    if (!attachment || attachment.workspace_id !== ctx.workspace.id || attachment.deleted_at) throw deny();
    await requireMediaOwner(ctx, attachment.owner_type, attachment.owner_id, "view");
    const { signed_url } = await ctx.sr.integrations.Core.CreateFileSignedUrl({
      file_uri: attachment.file_uri, expires_in: SIGNED_URL_SECONDS,
    });
    return { url: signed_url, expires_in: SIGNED_URL_SECONDS, file_name: attachment.file_name, content_type: attachment.content_type };
  },

  rename_attachment: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const attachment = await ctx.sr.entities.Attachment.get(payload.attachment_id).catch(() => null);
    if (!attachment || attachment.workspace_id !== ctx.workspace.id || attachment.deleted_at) throw deny();
    await requireMediaOwner(ctx, attachment.owner_type, attachment.owner_id, "edit_inventory");
    const fileName = String(payload.file_name ?? "").trim().slice(0, 255);
    if (!fileName) throw badRequest("file_name required");
    const updated = await ctx.sr.entities.Attachment.update(attachment.id, { file_name: fileName });
    return { attachment: publicAttachment(updated) };
  },

  /** Replace keeps prior versions listed and adjusts storage by the delta. */
  replace_attachment: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const attachment = await ctx.sr.entities.Attachment.get(payload.attachment_id).catch(() => null);
    if (!attachment || attachment.workspace_id !== ctx.workspace.id || attachment.deleted_at) throw deny();
    await requireMediaOwner(ctx, attachment.owner_type, attachment.owner_id, "edit_inventory");
    const fileUri = String(payload.file_uri ?? "");
    const bytes = Number(payload.bytes);
    if (!fileUri || !Number.isFinite(bytes) || bytes <= 0) throw badRequest("file_uri and bytes required");
    await assertStorageAvailable(ctx.sr, ctx.workspace.id, bytes);

    const updated = await ctx.sr.entities.Attachment.update(attachment.id, {
      file_uri: fileUri,
      bytes,
      version: (attachment.version ?? 1) + 1,
      previous_versions: [
        ...(attachment.previous_versions ?? []),
        { file_uri: attachment.file_uri, version: attachment.version ?? 1, bytes: attachment.bytes ?? 0, replaced_at: new Date().toISOString() },
      ].slice(-10),
    });
    await adjustStorageUsed(ctx.sr, ctx.workspace.id, bytes);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "attachment.replaced",
      target_type: attachment.owner_type, target_id: attachment.owner_id, target_label: attachment.file_name,
    });
    return { attachment: publicAttachment(updated) };
  },

  delete_attachment: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const attachment = await ctx.sr.entities.Attachment.get(payload.attachment_id).catch(() => null);
    if (!attachment || attachment.workspace_id !== ctx.workspace.id || attachment.deleted_at) throw deny();
    await requireMediaOwner(ctx, attachment.owner_type, attachment.owner_id, "archive_inventory");
    await ctx.sr.entities.Attachment.update(attachment.id, {
      deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + RECOVERY_DAYS * 86400_000).toISOString(),
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "attachment.deleted",
      target_type: attachment.owner_type, target_id: attachment.owner_id, target_label: attachment.file_name,
    });
    return { deleted: true };
  },

  /** Soft delete into 30-day recovery; storage stays counted until purge. */
  delete_media: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const media = await ctx.sr.entities.MediaAsset.get(payload.media_id).catch(() => null);
    if (!media || media.workspace_id !== ctx.workspace.id || media.deleted_at) throw deny();
    await requireMediaOwner(ctx, media.owner_type, media.owner_id, "archive_inventory");
    await ctx.sr.entities.MediaAsset.update(media.id, {
      deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + RECOVERY_DAYS * 86400_000).toISOString(),
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "media.deleted",
      target_type: media.owner_type, target_id: media.owner_id,
    });
    return { deleted: true };
  },

  restore_media: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "recover_deleted");
    const media = await ctx.sr.entities.MediaAsset.get(payload.media_id).catch(() => null);
    if (!media || media.workspace_id !== ctx.workspace.id || !media.deleted_at) throw deny();
    await requireMediaOwner(ctx, media.owner_type, media.owner_id, "recover_deleted");
    await ctx.sr.entities.MediaAsset.update(media.id, { deleted_at: null, purge_after: null });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "media.recovered",
      target_type: media.owner_type, target_id: media.owner_id,
    });
    return { restored: true };
  },
});
