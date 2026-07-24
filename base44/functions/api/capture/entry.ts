// api/capture — AI-assisted inventory entry. Every AI result lands as a DRAFT
// item that a person must confirm; nothing is saved silently. The model is
// instructed to describe only visible objects and mark uncertainty. Voice
// capture is post-launch (CaptureSession already models it).

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny, ApiError, safeError } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds } from "../../../shared/authz.ts";
import { requireContainer, requireItem } from "../../../shared/inventory.ts";
import { logActivity } from "../../../shared/audit.ts";
import { chargeAiAction, getSubscription, limitsFor } from "../../../shared/entitlements.ts";
import { buildSearchText } from "../../../shared/searchtext.ts";

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number", description: "Only when clearly countable in the photo; omit otherwise" },
          category: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["name", "confidence"],
      },
    },
    photo_note: { type: "string", description: "One sentence about overall photo quality/visibility" },
  },
  required: ["items"],
};

const ANALYSIS_PROMPT =
  "You are cataloging the contents of a storage container from photos. " +
  "List ONLY objects that are actually visible. Never guess at hidden, occluded, or implied contents. " +
  "Give a short, searchable name for each object (e.g. 'HDMI cables', 'red coffee mug'). " +
  "Include a quantity only when you can clearly count it in the photo. " +
  "Set confidence to 'low' for anything partially visible or ambiguous, 'medium' when fairly sure, 'high' only when unmistakable. " +
  "If the photo shows no recognizable objects, return an empty items list.";

function draftItem(i: Record<string, any>) {
  return {
    id: i.id, container_id: i.container_id, name: i.name,
    quantity: i.quantity ?? null, category: i.category, tags: i.tags ?? [],
    description: i.description, ai_confidence: i.ai_confidence,
    state: i.state, origin: i.origin, capture_session_id: i.capture_session_id,
  };
}

serveActions({
  /** Analyze container photos → draft items awaiting human confirmation. */
  analyze_photos: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const container = await requireContainer(ctx, payload.container_id, "create_inventory");
    if (container.archived) throw badRequest("Restore the container first");

    const requested = Array.isArray(payload.media_ids)
      ? payload.media_ids.filter((x: unknown) => typeof x === "string")
      : [];
    if (!requested.length) throw badRequest("media_ids required");

    // Only analyze photos that haven't already been through a successful
    // analysis for this container. Re-running "Analyze with AI" after adding a
    // new photo must not re-surface drafts the user already accepted or
    // dismissed for earlier photos.
    const priorSessions = await ctx.sr.entities.CaptureSession
      .filter({ workspace_id: ctx.workspace.id, container_id: container.id })
      .catch(() => [] as any[]);
    const analyzed = new Set<string>();
    for (const s of priorSessions) {
      if (s.kind === "photo_ai" && s.status === "ready" && Array.isArray(s.media_ids)) {
        for (const m of s.media_ids) analyzed.add(m);
      }
    }
    const mediaIds = requested.filter((id: string) => !analyzed.has(id)).slice(0, 5);
    if (!mediaIds.length) {
      // Everything supplied was already analyzed — no charge, no LLM call.
      return { session_id: null, status: "ready", photo_note: null, drafts: [], nothing_new: true };
    }

    const fileUrls: string[] = [];
    for (const id of mediaIds) {
      const media = await ctx.sr.entities.MediaAsset.get(id).catch(() => null);
      if (!media || media.workspace_id !== ctx.workspace.id || media.deleted_at) throw deny();
      const uri = media.file_uris?.full ?? media.file_uris?.medium;
      if (!uri) continue;
      const { signed_url } = await ctx.sr.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 600 });
      fileUrls.push(signed_url);
    }
    if (!fileUrls.length) throw badRequest("No usable photo files");

    await chargeAiAction(ctx.sr, ctx.workspace.id);
    const session = await ctx.sr.entities.CaptureSession.create({
      workspace_id: ctx.workspace.id, container_id: container.id,
      kind: "photo_ai", status: "processing", media_ids: mediaIds,
    });

    try {
      const result: any = await ctx.sr.integrations.Core.InvokeLLM({
        prompt: ANALYSIS_PROMPT,
        file_urls: fileUrls,
        response_json_schema: ANALYSIS_SCHEMA,
      });
      const proposed = Array.isArray(result?.items) ? result.items.slice(0, 50) : [];
      const draftIds: string[] = [];
      const drafts = [];
      for (const p of proposed) {
        const name = typeof p?.name === "string" ? p.name.trim().slice(0, 300) : "";
        if (!name) continue;
        const item = await ctx.sr.entities.Item.create({
          workspace_id: ctx.workspace.id,
          container_id: container.id,
          location_id: container.location_id,
          name,
          quantity: Number.isFinite(p.quantity) && p.quantity > 0 ? p.quantity : undefined,
          category: typeof p.category === "string" ? p.category : undefined,
          tags: Array.isArray(p.tags) ? p.tags.filter((x: unknown) => typeof x === "string").slice(0, 10) : [],
          description: typeof p.description === "string" ? p.description : undefined,
          state: "draft",
          origin: "photo_ai",
          ai_confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "low",
          capture_session_id: session.id,
          search_text: buildSearchText([name, p.category, p.tags]),
          updated_by_user_id: ctx.user.id,
        });
        draftIds.push(item.id);
        drafts.push(item);
      }
      await ctx.sr.entities.CaptureSession.update(session.id, {
        status: "ready", draft_item_ids: draftIds,
      });
      await logActivity(ctx.sr, {
        workspace_id: ctx.workspace.id, actor: ctx.user, action: "capture.photo_analyzed",
        target_type: "container", target_id: container.id, metadata: { draft_count: draftIds.length },
      });
      return {
        session_id: session.id,
        status: "ready",
        photo_note: typeof result?.photo_note === "string" ? result.photo_note : null,
        drafts: drafts.map(draftItem),
      };
    } catch (err) {
      console.error("[capture] analysis failed:", safeError(err));
      await ctx.sr.entities.CaptureSession.update(session.id, { status: "failed", error_code: "analysis_failed" });
      throw new ApiError(502, "analysis_failed", "Photo analysis didn't complete. Nothing was saved.");
    }
  },

  list_drafts: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const accessible = await accessibleLocationIds(ctx);
    const query: Record<string, unknown> = { workspace_id: ctx.workspace.id, state: "draft" };
    if (typeof payload.container_id === "string" && payload.container_id) {
      await requireContainer(ctx, payload.container_id, "view");
      query.container_id = payload.container_id;
    }
    const items = await ctx.sr.entities.Item.filter(query, "-created_date", 200);
    return {
      drafts: items
        .filter((i: any) => !i.deleted_at && (accessible === null || accessible.has(i.location_id)))
        .map(draftItem),
    };
  },

  /** Human approval: drafts become real inventory, with optional inline edits. */
  confirm_drafts: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const entries = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
    if (!entries.length) throw badRequest("items required");
    const confirmed = [];
    for (const entry of entries) {
      const item = await requireItem(ctx, entry?.item_id, "create_inventory");
      if (item.state !== "draft" || item.deleted_at) continue;
      const patch: Record<string, unknown> = { state: "confirmed", updated_by_user_id: ctx.user.id };
      const edits = entry?.patch ?? {};
      if (typeof edits.name === "string" && edits.name.trim()) patch.name = edits.name.trim().slice(0, 300);
      if (edits.quantity === null || (Number.isFinite(edits.quantity) && edits.quantity >= 0)) patch.quantity = edits.quantity;
      if (typeof edits.category === "string") patch.category = edits.category;
      if (Array.isArray(edits.tags)) patch.tags = edits.tags.filter((x: unknown) => typeof x === "string");
      patch.search_text = buildSearchText([
        (patch.name as string) ?? item.name, (patch.category as string) ?? item.category,
        (patch.tags as string[]) ?? item.tags, item.description,
      ]);
      confirmed.push(await ctx.sr.entities.Item.update(item.id, patch));
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "capture.drafts_confirmed",
      metadata: { count: confirmed.length },
    });
    return { confirmed: confirmed.map(draftItem) };
  },

  /** Rejected drafts are removed entirely — they never were inventory. */
  discard_drafts: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ids = Array.isArray(payload.item_ids) ? payload.item_ids.slice(0, 100) : [];
    let discarded = 0;
    for (const id of ids) {
      const item = await requireItem(ctx, id, "create_inventory");
      if (item.state !== "draft") continue;
      await ctx.sr.entities.Item.delete(item.id);
      discarded++;
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "capture.drafts_discarded",
      metadata: { count: discarded },
    });
    return { discarded };
  },

  /** Business barcode lookup: suggestions only — the user decides what to add. */
  barcode_lookup: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    if (ctx.workspace.workspace_type === "household") {
      throw badRequest("Product barcode scanning is available in Business and Organization workspaces");
    }
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    if (!limitsFor(sub).barcode_scanning) throw new ApiError(402, "plan_limit", "barcode_scanning");

    const barcode = String(payload.barcode ?? "").replace(/\D/g, "");
    if (barcode.length < 8 || barcode.length > 14) throw badRequest("Enter a valid UPC, EAN, or ISBN");
    await chargeAiAction(ctx.sr, ctx.workspace.id);

    const result: any = await ctx.sr.integrations.Core.InvokeLLM({
      prompt:
        `Identify the retail product with barcode ${barcode} (UPC/EAN/ISBN). ` +
        "Use internet sources. If you cannot identify it reliably, set found=false and leave other fields empty. " +
        "Never invent details.",
      add_context_from_internet: true,
      response_json_schema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          name: { type: "string" },
          brand: { type: "string" },
          model: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
        },
        required: ["found"],
      },
    });
    return {
      barcode,
      suggestion: result?.found
        ? {
          name: result.name ?? "", brand: result.brand ?? "", model: result.model ?? "",
          description: result.description ?? "", category: result.category ?? "",
        }
        : null,
    };
  },

  /** The user's approval step: create the item from reviewed barcode fields. */
  barcode_add: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    if (ctx.workspace.workspace_type === "household") throw badRequest("Business workspaces only");
    const container = await requireContainer(ctx, payload.container_id, "create_inventory");
    if (container.archived) throw badRequest("Restore the container first");
    const f = payload.fields ?? {};
    const name = typeof f.name === "string" ? f.name.trim().slice(0, 300) : "";
    if (!name) throw badRequest("Item name is required");
    const item = await ctx.sr.entities.Item.create({
      workspace_id: ctx.workspace.id,
      container_id: container.id,
      location_id: container.location_id,
      name,
      quantity: Number.isFinite(f.quantity) && f.quantity >= 0 ? f.quantity : undefined,
      brand: typeof f.brand === "string" ? f.brand : undefined,
      model: typeof f.model === "string" ? f.model : undefined,
      description: typeof f.description === "string" ? f.description : undefined,
      category: typeof f.category === "string" ? f.category : undefined,
      barcode: typeof payload.barcode === "string" ? payload.barcode.replace(/\D/g, "") : undefined,
      state: "confirmed",
      origin: "barcode",
      search_text: buildSearchText([name, f.brand, f.model, f.category, f.description]),
      updated_by_user_id: ctx.user.id,
    });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "item.created",
      target_type: "item", target_id: item.id, target_label: name, metadata: { origin: "barcode" },
    });
    return { item: draftItem(item) };
  },
});
