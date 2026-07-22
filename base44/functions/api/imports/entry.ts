// api/imports — CSV import (analyze → commit → undo) and CSV export.
// Import is a paid-plan, admin-capability feature; every created record is
// stamped with its Job id so an import can be fully undone. Export is a
// distinct permission and always emits stable record IDs for safe reimport.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny, ApiError } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds } from "../../../shared/authz.ts";
import { logActivity } from "../../../shared/audit.ts";
import { getSubscription, limitsFor, assertWithinLimit } from "../../../shared/entitlements.ts";
import { parseCsv, toCsv } from "../../../shared/csv.ts";
import { allocateNumberBlock, formatNumber } from "../../../shared/numbering.ts";
import { newQrToken } from "../../../shared/tokens.ts";
import { buildSearchText } from "../../../shared/searchtext.ts";

const MAX_ROWS = 500;
const PATH_SEP = /\s*(?:›|>|\/)\s*/;

type Kind = "containers" | "items" | "locations";

const FIELD_HINTS: Record<Kind, Record<string, string[]>> = {
  containers: {
    title: ["title", "name", "container", "label"],
    container_type: ["type", "container type", "kind"],
    category: ["category"],
    location_path: ["location", "location path", "where", "place"],
    description: ["description", "desc"],
    notes: ["notes", "note"],
    tags: ["tags", "tag"],
  },
  items: {
    name: ["name", "item", "item name", "title"],
    container_number: ["container number", "container #", "bin", "bin number", "number"],
    container_title: ["container", "container title", "container name"],
    quantity: ["quantity", "qty", "count", "amount"],
    category: ["category"],
    description: ["description", "desc"],
    notes: ["notes", "note"],
    tags: ["tags", "tag"],
    brand: ["brand", "make"],
    model: ["model"],
    serial_number: ["serial", "serial number", "serial #", "sn"],
  },
  locations: {
    path: ["path", "location", "location path", "name", "full path"],
  },
};

const REQUIRED: Record<Kind, string[]> = {
  containers: ["title"],
  items: ["name"],
  locations: ["path"],
};

function proposeMapping(kind: Kind, headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const [field, hints] of Object.entries(FIELD_HINTS[kind])) {
    const idx = normalized.findIndex((h) => hints.includes(h));
    if (idx >= 0) mapping[field] = idx;
  }
  return mapping;
}

function rowValue(row: string[], mapping: Record<string, number>, field: string): string {
  const idx = mapping[field];
  return idx != null && idx >= 0 && idx < row.length ? row[idx].trim() : "";
}

async function requireImportContext(base44: any, workspaceId: unknown) {
  const ctx = await requireMember(base44, workspaceId, "import");
  const sub = await getSubscription(ctx.sr, ctx.workspace.id);
  if (!limitsFor(sub).csv_import) throw new ApiError(402, "plan_limit", "csv_import");
  return ctx;
}

function parseUpload(payload: Record<string, any>): { headers: string[]; rows: string[][] } {
  const text = typeof payload.csv_text === "string" ? payload.csv_text : "";
  if (!text.trim()) throw badRequest("csv_text required");
  const all = parseCsv(text, MAX_ROWS + 2);
  if (all.length < 2) throw badRequest("The CSV needs a header row and at least one data row");
  if (all.length > MAX_ROWS + 1) throw badRequest(`Imports are limited to ${MAX_ROWS} rows at a time`);
  return { headers: all[0], rows: all.slice(1) };
}

serveActions({
  /** Step 1–4 of the wizard: detect columns, validate, and flag duplicates. */
  import_analyze: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireImportContext(base44, payload.workspace_id);
    const kind = payload.kind as Kind;
    if (!["containers", "items", "locations"].includes(kind)) throw badRequest("Invalid kind");
    const { headers, rows } = parseUpload(payload);
    const mapping = (payload.mapping as Record<string, number>) ?? proposeMapping(kind, headers);

    const missing = REQUIRED[kind].filter((f) => mapping[f] == null);
    const issues: Array<{ row: number; problem: string }> = [];
    let duplicates = 0;
    let valid = 0;

    const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const containers = await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000);
    const items = kind === "items"
      ? await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000)
      : [];
    const pathSet = new Set(locations.map((l: any) => l.path_text.toLowerCase()));
    const titleSet = new Set(containers.filter((c: any) => !c.archived).map((c: any) => c.title.toLowerCase()));
    const numberMap = new Map(containers.map((c: any) => [c.number, c]));

    if (!missing.length) {
      rows.forEach((row, i) => {
        const n = i + 2;
        if (kind === "containers") {
          const title = rowValue(row, mapping, "title");
          if (!title) { issues.push({ row: n, problem: "Missing title" }); return; }
          if (titleSet.has(title.toLowerCase())) duplicates++;
          valid++;
        } else if (kind === "items") {
          const name = rowValue(row, mapping, "name");
          if (!name) { issues.push({ row: n, problem: "Missing name" }); return; }
          const qty = rowValue(row, mapping, "quantity");
          if (qty && !Number.isFinite(Number(qty))) { issues.push({ row: n, problem: `Quantity "${qty}" is not a number` }); return; }
          const num = rowValue(row, mapping, "container_number");
          const ctitle = rowValue(row, mapping, "container_title");
          if (num && !numberMap.has(parseInt(num, 10))) { issues.push({ row: n, problem: `No container number ${num}` }); return; }
          if (!num && ctitle && !titleSet.has(ctitle.toLowerCase())) { issues.push({ row: n, problem: `No container titled "${ctitle}"` }); return; }
          if (!num && !ctitle) { issues.push({ row: n, problem: "No container reference" }); return; }
          const target = num ? numberMap.get(parseInt(num, 10)) : containers.find((c: any) => c.title.toLowerCase() === ctitle.toLowerCase());
          if (target && items.some((it: any) => it.container_id === target.id && !it.deleted_at && it.name.toLowerCase() === name.toLowerCase())) duplicates++;
          valid++;
        } else {
          const path = rowValue(row, mapping, "path");
          if (!path) { issues.push({ row: n, problem: "Missing path" }); return; }
          if (pathSet.has(path.split(PATH_SEP).join(" › ").toLowerCase())) duplicates++;
          valid++;
        }
      });
    }

    return {
      headers,
      mapping,
      missing_required: missing,
      row_count: rows.length,
      valid_rows: valid,
      duplicate_rows: duplicates,
      issues: issues.slice(0, 50),
      preview: rows.slice(0, 5),
    };
  },

  /** Steps 5–8: apply with a chosen duplicate strategy; everything stamped for undo. */
  import_commit: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireImportContext(base44, payload.workspace_id);
    const kind = payload.kind as Kind;
    if (!["containers", "items", "locations"].includes(kind)) throw badRequest("Invalid kind");
    const dupMode = ["skip", "create", "merge"].includes(payload.duplicate_mode as string)
      ? payload.duplicate_mode as string : "skip";
    const { headers, rows } = parseUpload(payload);
    const mapping = (payload.mapping as Record<string, number>) ?? proposeMapping(kind, headers);
    for (const f of REQUIRED[kind]) if (mapping[f] == null) throw badRequest(`Map the "${f}" column first`);

    const job = await ctx.sr.entities.Job.create({
      workspace_id: ctx.workspace.id, kind: "import", status: "running",
      params: { kind, duplicate_mode: dupMode, rows: rows.length },
      created_by_user_id: ctx.user.id,
    });

    const summary = { created: 0, merged: 0, skipped: 0, errors: [] as Array<{ row: number; problem: string }> };
    try {
      const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
      const byPath = new Map(locations.map((l: any) => [l.path_text.toLowerCase(), l]));
      const containers = await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000);
      const byTitle = new Map(containers.filter((c: any) => !c.archived).map((c: any) => [c.title.toLowerCase(), c]));
      const byNumber = new Map(containers.map((c: any) => [c.number, c]));

      const ensureLocation = async (rawPath: string) => {
        const segments = rawPath.split(PATH_SEP).map((s) => s.trim()).filter(Boolean).slice(0, 6);
        if (!segments.length) return null;
        let parent: any = null;
        let pathText = "";
        for (const segment of segments) {
          pathText = pathText ? `${pathText} › ${segment}` : segment;
          let node = byPath.get(pathText.toLowerCase());
          if (!node) {
            await assertWithinLimit(ctx.sr, ctx.workspace.id, "locations");
            node = await ctx.sr.entities.Location.create({
              workspace_id: ctx.workspace.id,
              parent_id: parent?.id ?? undefined,
              name: segment,
              level: parent ? (parent.level ?? 0) + 1 : 0,
              path_ids: parent ? [...(parent.path_ids ?? []), parent.id] : [],
              path_text: pathText,
              archived: false,
              import_job_id: job.id,
            });
            byPath.set(pathText.toLowerCase(), node);
          }
          parent = node;
        }
        return parent;
      };

      if (kind === "locations") {
        for (let i = 0; i < rows.length; i++) {
          const path = rowValue(rows[i], mapping, "path");
          if (!path) { summary.errors.push({ row: i + 2, problem: "Missing path" }); continue; }
          const normalized = path.split(PATH_SEP).join(" › ").toLowerCase();
          if (byPath.has(normalized)) { summary.skipped++; continue; }
          await ensureLocation(path);
          summary.created++;
        }
      } else if (kind === "containers") {
        const pending: Array<{ row: string[]; location: any }> = [];
        for (let i = 0; i < rows.length; i++) {
          const title = rowValue(rows[i], mapping, "title");
          if (!title) { summary.errors.push({ row: i + 2, problem: "Missing title" }); continue; }
          const existing = byTitle.get(title.toLowerCase());
          if (existing && dupMode === "skip") { summary.skipped++; continue; }
          if (existing && dupMode === "merge") {
            const patch: Record<string, unknown> = {};
            for (const f of ["category", "description", "notes"]) {
              const v = rowValue(rows[i], mapping, f === "category" ? "category" : f);
              if (v && !existing[f]) patch[f] = v;
            }
            if (Object.keys(patch).length) await ctx.sr.entities.Container.update(existing.id, patch);
            summary.merged++;
            continue;
          }
          const rawPath = rowValue(rows[i], mapping, "location_path");
          const location = rawPath ? await ensureLocation(rawPath) : (locations[0] ?? null);
          if (!location) { summary.errors.push({ row: i + 2, problem: "No location (map a Location column or create one first)" }); continue; }
          pending.push({ row: rows[i], location });
        }
        await assertWithinLimit(ctx.sr, ctx.workspace.id, "containers");
        const created: any[] = [];
        for (const p of pending) {
          const type = rowValue(p.row, mapping, "container_type").toLowerCase().replace(/\s+/g, "_");
          created.push(await ctx.sr.entities.Container.create({
            workspace_id: ctx.workspace.id,
            location_id: p.location.id,
            qr_token: newQrToken(),
            container_type: ["bin", "tote", "box", "crate", "bag", "drawer", "cabinet", "trunk", "case", "bucket", "file_box"].includes(type) ? type : "bin",
            title: rowValue(p.row, mapping, "title").slice(0, 200),
            category: rowValue(p.row, mapping, "category") || undefined,
            description: rowValue(p.row, mapping, "description") || undefined,
            notes: rowValue(p.row, mapping, "notes") || undefined,
            tags: rowValue(p.row, mapping, "tags") ? rowValue(p.row, mapping, "tags").split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
            label_status: "not_printed",
            archived: false,
            pending_number: true,
            import_job_id: job.id,
            updated_by_user_id: ctx.user.id,
          }));
        }
        const numbers = await allocateNumberBlock(ctx.sr, ctx.workspace.id, created.map((c) => c.id));
        for (let i = 0; i < created.length; i++) {
          await ctx.sr.entities.Container.update(created[i].id, {
            number: numbers[i], number_display: formatNumber(numbers[i]), pending_number: false,
            search_text: buildSearchText([created[i].title, created[i].category, created[i].tags, formatNumber(numbers[i])]),
          });
          summary.created++;
        }
      } else {
        const existingItems = await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000);
        for (let i = 0; i < rows.length; i++) {
          const name = rowValue(rows[i], mapping, "name");
          if (!name) { summary.errors.push({ row: i + 2, problem: "Missing name" }); continue; }
          const num = parseInt(rowValue(rows[i], mapping, "container_number"), 10);
          const ctitle = rowValue(rows[i], mapping, "container_title");
          const container = Number.isInteger(num) && num > 0 ? byNumber.get(num) : byTitle.get(ctitle.toLowerCase());
          if (!container) { summary.errors.push({ row: i + 2, problem: "Container not found" }); continue; }
          const dup = existingItems.find((it: any) =>
            it.container_id === container.id && !it.deleted_at && it.name.toLowerCase() === name.toLowerCase());
          const qtyRaw = rowValue(rows[i], mapping, "quantity");
          const qty = qtyRaw && Number.isFinite(Number(qtyRaw)) ? Number(qtyRaw) : null;
          if (dup && dupMode === "skip") { summary.skipped++; continue; }
          if (dup && dupMode === "merge") {
            if (qty != null && dup.quantity != null) {
              await ctx.sr.entities.Item.update(dup.id, { quantity: dup.quantity + qty });
            }
            summary.merged++;
            continue;
          }
          await ctx.sr.entities.Item.create({
            workspace_id: ctx.workspace.id,
            container_id: container.id,
            location_id: container.location_id,
            name: name.slice(0, 300),
            quantity: qty ?? undefined,
            category: rowValue(rows[i], mapping, "category") || undefined,
            description: rowValue(rows[i], mapping, "description") || undefined,
            notes: rowValue(rows[i], mapping, "notes") || undefined,
            brand: rowValue(rows[i], mapping, "brand") || undefined,
            model: rowValue(rows[i], mapping, "model") || undefined,
            serial_number: rowValue(rows[i], mapping, "serial_number") || undefined,
            tags: rowValue(rows[i], mapping, "tags") ? rowValue(rows[i], mapping, "tags").split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
            state: "confirmed",
            origin: "import",
            archived: false,
            import_job_id: job.id,
            search_text: buildSearchText([name, rowValue(rows[i], mapping, "category"), rowValue(rows[i], mapping, "brand")]),
            updated_by_user_id: ctx.user.id,
          });
          summary.created++;
        }
      }

      await ctx.sr.entities.Job.update(job.id, { status: "done", result: summary });
      await logActivity(ctx.sr, {
        workspace_id: ctx.workspace.id, actor: ctx.user, action: "import.completed",
        target_type: "job", target_id: job.id, metadata: { kind, ...summary, errors: summary.errors.length },
      });
      return { job_id: job.id, ...summary };
    } catch (err) {
      await ctx.sr.entities.Job.update(job.id, { status: "failed", error_code: "import_failed" });
      throw err;
    }
  },

  /** Complete undo: every record stamped with this job disappears. Numbers stay retired. */
  import_undo: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireImportContext(base44, payload.workspace_id);
    const job = await ctx.sr.entities.Job.get(payload.job_id).catch(() => null);
    if (!job || job.workspace_id !== ctx.workspace.id || job.kind !== "import" || job.status !== "done") throw deny();

    let removed = 0;
    for (const entity of ["Item", "Container", "Location"]) {
      const records = await ctx.sr.entities[entity].filter({ workspace_id: ctx.workspace.id, import_job_id: job.id });
      for (const r of records) {
        await ctx.sr.entities[entity].delete(r.id);
        removed++;
      }
    }
    await ctx.sr.entities.Job.update(job.id, { status: "undone", result: { ...(job.result ?? {}), undone_records: removed } });
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "import.undone",
      target_type: "job", target_id: job.id, metadata: { removed },
    });
    return { undone: true, removed };
  },

  list_jobs: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "import");
    const jobs = await ctx.sr.entities.Job.filter({ workspace_id: ctx.workspace.id, kind: "import" }, "-created_date", 20);
    return { jobs: jobs.map((j: any) => ({ id: j.id, status: j.status, params: j.params, result: j.result, created_date: j.created_date })) };
  },

  /** CSV export with stable IDs. A distinct capability from viewing. */
  export_csv: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "export");
    const accessible = await accessibleLocationIds(ctx);
    const scoped = (locId: string) => accessible === null || accessible.has(locId);
    const kind = ["workspace", "containers", "items", "archived"].includes(payload.kind as string)
      ? payload.kind as string : "workspace";

    const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const locById = new Map(locations.map((l: any) => [l.id, l]));
    let containers = (await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "number", 1000))
      .filter((c: any) => scoped(c.location_id));
    let items = (await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000))
      .filter((i: any) => !i.deleted_at && i.state === "confirmed" && scoped(i.location_id));
    if (typeof payload.location_id === "string" && payload.location_id) {
      const within = (locId: string) => {
        const l = locById.get(locId);
        return l && (l.id === payload.location_id || (l.path_ids ?? []).includes(payload.location_id));
      };
      containers = containers.filter((c: any) => within(c.location_id));
      items = items.filter((i: any) => within(i.location_id));
    }
    if (kind === "archived") {
      containers = containers.filter((c: any) => c.archived);
      items = items.filter((i: any) => i.archived);
    } else {
      containers = containers.filter((c: any) => !c.archived);
      items = items.filter((i: any) => !i.archived);
    }

    const files: Array<{ name: string; url: string }> = [];
    const upload = async (name: string, csv: string) => {
      const file = new File([csv], name, { type: "text/csv" });
      const res: any = await ctx.sr.integrations.Core.UploadPrivateFile({ file });
      const uri = res?.file_uri ?? res?.data?.file_uri;
      const { signed_url } = await ctx.sr.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 900 });
      files.push({ name, url: signed_url });
    };

    if (kind !== "items") {
      await upload(`containers-${Date.now()}.csv`, toCsv([
        ["id", "number", "title", "type", "category", "location_path", "tags", "notes", "archived", "created_date"],
        ...containers.map((c: any) => [
          c.id, c.number, c.title, c.container_type, c.category ?? "",
          locById.get(c.location_id)?.path_text ?? "", (c.tags ?? []).join("; "),
          c.notes ?? "", c.archived ? "yes" : "no", c.created_date,
        ]),
      ]));
    }
    if (kind !== "containers") {
      const containerById = new Map(containers.map((c: any) => [c.id, c]));
      await upload(`items-${Date.now()}.csv`, toCsv([
        ["id", "name", "quantity", "category", "tags", "notes", "brand", "model", "serial_number",
          "container_id", "container_number", "container_title", "location_path", "created_date"],
        ...items.map((i: any) => {
          const c = containerById.get(i.container_id);
          return [
            i.id, i.name, i.quantity ?? "", i.category ?? "", (i.tags ?? []).join("; "), i.notes ?? "",
            i.brand ?? "", i.model ?? "", i.serial_number ?? "",
            i.container_id, c?.number ?? "", c?.title ?? "",
            locById.get(i.location_id)?.path_text ?? "", i.created_date,
          ];
        }),
      ]));
    }

    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "export.generated",
      metadata: { kind, containers: containers.length, items: items.length },
    });
    return { files, expires_in: 900, counts: { containers: containers.length, items: items.length } };
  },
});
