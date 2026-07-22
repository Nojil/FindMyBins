// api/reports — backend-generated PDF inventory reports. Data is scoped to the
// caller's accessible locations before a single glyph is drawn; the PDF lands
// in private storage behind a short-lived signed URL.

import { createClientFromRequest } from "npm:@base44/sdk";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import { serveActions, badRequest } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds } from "../../../shared/authz.ts";
import { logActivity } from "../../../shared/audit.ts";
import { getSubscription, limitsFor } from "../../../shared/entitlements.ts";
import { formatNumber } from "../../../shared/numbering.ts";
import { QR_LINK_BASE } from "../../../shared/tokens.ts";
import { drawQrOnPage, fitText } from "../../../shared/pdfqr.ts";

const PAGE_W = 612, PAGE_H = 792, MARGIN = 54;
const KINDS = ["workspace", "location", "container", "category", "archive", "missing_details", "recent_changes"] as const;

serveActions({
  generate: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "reports");
    const kind = payload.kind as (typeof KINDS)[number];
    if (!KINDS.includes(kind)) throw badRequest("Invalid report kind");
    const opts = payload.options ?? {};
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    const advanced = limitsFor(sub).advanced_reports;
    const includeQr = opts.include_qr === true;
    const includeNotes = opts.include_notes !== false;
    const branding = advanced && opts.branding !== false;

    const accessible = await accessibleLocationIds(ctx);
    const scoped = (locId: string) => accessible === null || accessible.has(locId);
    const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const locById = new Map(locations.map((l: any) => [l.id, l]));
    let containers = (await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "number", 1000))
      .filter((c: any) => scoped(c.location_id));
    let items = (await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000))
      .filter((i: any) => !i.deleted_at && i.state === "confirmed" && scoped(i.location_id));

    let title = `${ctx.workspace.name} — Inventory report`;
    if (kind === "archive") {
      containers = containers.filter((c: any) => c.archived);
      items = items.filter((i: any) => containers.some((c: any) => c.id === i.container_id));
      title = `${ctx.workspace.name} — Archived inventory`;
    } else {
      containers = containers.filter((c: any) => !c.archived);
      items = items.filter((i: any) => !i.archived);
    }
    if (kind === "location") {
      const locId = String(payload.location_id ?? "");
      const within = (id: string) => {
        const l = locById.get(id);
        return l && (l.id === locId || (l.path_ids ?? []).includes(locId));
      };
      if (!locById.has(locId)) throw badRequest("location_id required");
      containers = containers.filter((c: any) => within(c.location_id));
      items = items.filter((i: any) => within(i.location_id));
      title = `${locById.get(locId).path_text} — Inventory`;
    }
    if (kind === "container") {
      containers = containers.filter((c: any) => c.id === payload.container_id);
      if (!containers.length) throw badRequest("container_id required");
      items = items.filter((i: any) => i.container_id === payload.container_id);
      title = `${formatNumber(containers[0].number)} ${containers[0].title}`;
    }
    if (kind === "category") {
      const cat = String(payload.category ?? "");
      if (!cat) throw badRequest("category required");
      const keep = new Set(items.filter((i: any) => i.category === cat).map((i: any) => i.container_id));
      containers = containers.filter((c: any) => c.category === cat || keep.has(c.id));
      items = items.filter((i: any) => i.category === cat);
      title = `${ctx.workspace.name} — Category: ${cat}`;
    }
    if (kind === "recent_changes") {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      containers = containers.filter((c: any) => c.updated_date > since);
      items = items.filter((i: any) => i.updated_date > since);
      title = `${ctx.workspace.name} — Changes in the last 30 days`;
    }
    if (kind === "missing_details") {
      const itemsByContainer = new Map<string, any[]>();
      for (const i of items) {
        if (!itemsByContainer.has(i.container_id)) itemsByContainer.set(i.container_id, []);
        itemsByContainer.get(i.container_id)!.push(i);
      }
      containers = containers.filter((c: any) => {
        const its = itemsByContainer.get(c.id) ?? [];
        return its.length === 0 || !c.category || its.some((i: any) => i.quantity == null);
      });
      items = items.filter((i: any) => containers.some((c: any) => c.id === i.container_id));
      title = `${ctx.workspace.name} — Missing details`;
    }

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    const pages: PDFPage[] = [page];

    const newPage = () => {
      page = doc.addPage([PAGE_W, PAGE_H]);
      pages.push(page);
      y = PAGE_H - MARGIN;
    };
    const ensure = (needed: number) => { if (y - needed < MARGIN + 24) newPage(); };
    const line = (text: string, f: PDFFont, size: number, color = rgb(0, 0, 0), indent = 0) => {
      ensure(size + 6);
      page.drawText(fitText(f, text, PAGE_W - 2 * MARGIN - indent, size), {
        x: MARGIN + indent, y: y - size, size, font: f, color,
      });
      y -= size + 6;
    };

    if (branding) {
      page.drawRectangle({ x: 0, y: PAGE_H - 26, width: PAGE_W, height: 26, color: rgb(0.06, 0.16, 0.26) });
      page.drawText(ctx.workspace.name, { x: MARGIN, y: PAGE_H - 19, size: 11, font: bold, color: rgb(1, 1, 1) });
      y = PAGE_H - MARGIN - 10;
    }
    line(title, bold, 20);
    line(`Generated ${new Date().toISOString().slice(0, 10)} · ${containers.length} containers · ${items.length} items`, font, 10, rgb(0.4, 0.4, 0.4));
    y -= 8;

    const sorted = [...containers].sort((a: any, b: any) =>
      (locById.get(a.location_id)?.path_text ?? "").localeCompare(locById.get(b.location_id)?.path_text ?? "") ||
      (a.number ?? 0) - (b.number ?? 0));
    let currentLocation = "";
    for (const c of sorted) {
      const path = locById.get(c.location_id)?.path_text ?? "";
      if (path !== currentLocation) {
        currentLocation = path;
        y -= 6;
        line(path || "(no location)", bold, 13, rgb(0.1, 0.35, 0.55));
      }
      const qrSize = includeQr ? 44 : 0;
      ensure(24 + qrSize);
      if (includeQr && c.qr_token) {
        drawQrOnPage(page, `${QR_LINK_BASE}${c.qr_token}`, PAGE_W - MARGIN - qrSize, y - qrSize, qrSize);
      }
      line(`${c.number ? formatNumber(c.number) : "—"}  ${c.title}${c.archived ? "  (archived)" : ""}`, bold, 12);
      if (c.category) line(`Category: ${c.category}`, font, 9, rgb(0.35, 0.35, 0.35), 12);
      if (includeNotes && c.notes) line(`Notes: ${c.notes}`, font, 9, rgb(0.35, 0.35, 0.35), 12);
      const contents = items.filter((i: any) => i.container_id === c.id);
      for (const i of contents) {
        line(`• ${i.name}${i.quantity != null ? `  ×${i.quantity}` : "  (quantity not specified)"}${i.category ? `  · ${i.category}` : ""}`, font, 10, rgb(0.15, 0.15, 0.15), 16);
      }
      if (!contents.length) line("• No items listed", font, 10, rgb(0.5, 0.5, 0.5), 16);
      if (includeQr) y = Math.min(y, y);
      y -= 4;
    }

    pages.forEach((p, idx) => {
      p.drawText(`FindMyBins · Page ${idx + 1} of ${pages.length}`, {
        x: MARGIN, y: MARGIN - 24, size: 8, font, color: rgb(0.55, 0.55, 0.55),
      });
    });

    const bytes = await doc.save();
    const file = new File([bytes], `report-${kind}-${Date.now()}.pdf`, { type: "application/pdf" });
    const up: any = await ctx.sr.integrations.Core.UploadPrivateFile({ file });
    const uri = up?.file_uri ?? up?.data?.file_uri;
    const { signed_url } = await ctx.sr.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 900 });

    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "report.generated",
      metadata: { kind, containers: containers.length, items: items.length },
    });
    return { pdf_url: signed_url, expires_in: 900, pages: pages.length, containers: containers.length, items: items.length };
  },
});
