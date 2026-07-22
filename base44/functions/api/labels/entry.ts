// api/labels — printable QR label PDFs and the print queue.
// QR codes are drawn as vector rectangles from the raw QR matrix (no canvas),
// always black-on-white regardless of app theme. PDFs land in private storage;
// access is via short-lived signed URLs only.

import { createClientFromRequest } from "npm:@base44/sdk";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import QRCode from "npm:qrcode@1.5.4";
import { serveActions, badRequest } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds, roleCan } from "../../../shared/authz.ts";
import { requireContainer } from "../../../shared/inventory.ts";
import { logActivity } from "../../../shared/audit.ts";
import { formatNumber } from "../../../shared/numbering.ts";
import { QR_LINK_BASE } from "../../../shared/tokens.ts";

const PT = 72; // points per inch

interface Format {
  page_w: number; page_h: number;
  label_w: number; label_h: number;
  cols: number; rows: number;
  margin_x: number; margin_y: number;
  gap_x: number; gap_y: number;
}

const PRESETS: Record<string, Format> = {
  // 2 × 5 grid of 4in × 2in labels (Avery 5163-compatible)
  letter_sheet: { page_w: 8.5 * PT, page_h: 11 * PT, label_w: 4 * PT, label_h: 2 * PT, cols: 2, rows: 5, margin_x: 0.19 * PT, margin_y: 0.5 * PT, gap_x: 0.12 * PT, gap_y: 0 },
  a4_sheet: { page_w: 595.28, page_h: 841.89, label_w: 4 * PT, label_h: 2 * PT, cols: 2, rows: 5, margin_x: 9.6, margin_y: 61, gap_x: 0.12 * PT, gap_y: 0 },
  thermal_4x6: { page_w: 4 * PT, page_h: 6 * PT, label_w: 4 * PT, label_h: 6 * PT, cols: 1, rows: 1, margin_x: 0, margin_y: 0, gap_x: 0, gap_y: 0 },
  label_3x2: { page_w: 3 * PT, page_h: 2 * PT, label_w: 3 * PT, label_h: 2 * PT, cols: 1, rows: 1, margin_x: 0, margin_y: 0, gap_x: 0, gap_y: 0 },
  label_2x1: { page_w: 2 * PT, page_h: 1 * PT, label_w: 2 * PT, label_h: 1 * PT, cols: 1, rows: 1, margin_x: 0, margin_y: 0, gap_x: 0, gap_y: 0 },
};

function resolveFormat(payload: Record<string, any>): Format {
  const preset = String(payload.format ?? "letter_sheet");
  if (PRESETS[preset]) return PRESETS[preset];
  if (preset !== "custom") throw badRequest("Unknown label format");
  const c = payload.custom ?? {};
  const inches = (v: unknown, name: string, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw badRequest(`Invalid custom dimension: ${name}`);
    return n * PT;
  };
  const fmt: Format = {
    page_w: inches(c.page_w_in, "page_w_in", 24), page_h: inches(c.page_h_in, "page_h_in", 24),
    label_w: inches(c.label_w_in, "label_w_in", 24), label_h: inches(c.label_h_in, "label_h_in", 24),
    cols: Math.min(Math.max(Number(c.cols) || 1, 1), 12), rows: Math.min(Math.max(Number(c.rows) || 1, 1), 20),
    margin_x: Number(c.margin_x_in) > 0 ? Number(c.margin_x_in) * PT : 0,
    margin_y: Number(c.margin_y_in) > 0 ? Number(c.margin_y_in) * PT : 0,
    gap_x: Number(c.gap_x_in) > 0 ? Number(c.gap_x_in) * PT : 0,
    gap_y: Number(c.gap_y_in) > 0 ? Number(c.gap_y_in) * PT : 0,
  };
  if (fmt.margin_x + fmt.cols * fmt.label_w + (fmt.cols - 1) * fmt.gap_x > fmt.page_w + 1 ||
      fmt.margin_y + fmt.rows * fmt.label_h + (fmt.rows - 1) * fmt.gap_y > fmt.page_h + 1) {
    throw badRequest("Labels do not fit on the page with these dimensions");
  }
  return fmt;
}

/** Draw a QR code as vector rects at (x, y bottom-left), sized to `size`. */
function drawQr(page: PDFPage, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.modules.data[row * n + col]) continue;
      page.drawRectangle({
        x: x + (col + quiet) * cell,
        y: y + size - (row + 1 + quiet) * cell,
        width: cell + 0.15,
        height: cell + 0.15,
        color: rgb(0, 0, 0),
      });
    }
  }
}

function fitText(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + "…", size) > maxWidth) out = out.slice(0, -1);
  return out + "…";
}

interface LabelOpts {
  show_title: boolean; show_location: boolean; show_category: boolean;
  show_workspace_name: boolean; instruction: string;
}

function drawLabel(
  page: PDFPage, fonts: { regular: PDFFont; bold: PDFFont },
  x: number, y: number, w: number, h: number,
  c: Record<string, any>, opts: LabelOpts,
): void {
  const pad = Math.min(10, h * 0.06);
  const qrSize = Math.min(h - 2 * pad, w * 0.42);
  const qrX = x + w - pad - qrSize;
  const qrY = y + (h - qrSize) / 2;
  drawQr(page, `${QR_LINK_BASE}${c.qr_token}`, qrX, qrY, qrSize);

  const textW = qrX - x - 2 * pad;
  const tiny = h < 90;
  const typeLabel = (c.container_type === "custom" && c.custom_type_label ? c.custom_type_label : c.container_type)
    .toUpperCase().replace("_", " ");
  const headline = `${typeLabel} ${c.number ? formatNumber(c.number) : "—"}`;

  let cursor = y + h - pad;
  const headSize = tiny ? Math.min(16, h * 0.3) : Math.min(26, h * 0.2);
  cursor -= headSize;
  page.drawText(fitText(fonts.bold, headline, textW, headSize), {
    x: x + pad, y: cursor, size: headSize, font: fonts.bold, color: rgb(0, 0, 0),
  });

  if (opts.show_title && c.title) {
    const size = tiny ? 8 : Math.min(14, h * 0.11);
    cursor -= size + (tiny ? 3 : 6);
    page.drawText(fitText(fonts.regular, c.title, textW, size), {
      x: x + pad, y: cursor, size, font: fonts.regular, color: rgb(0, 0, 0),
    });
  }
  if (!tiny && opts.show_category && c.category) {
    cursor -= 12;
    page.drawText(fitText(fonts.regular, c.category, textW, 9), {
      x: x + pad, y: cursor, size: 9, font: fonts.regular, color: rgb(0.25, 0.25, 0.25),
    });
  }

  let bottom = y + pad;
  if (!tiny && opts.instruction) {
    page.drawText(fitText(fonts.regular, opts.instruction, textW, 7), {
      x: x + pad, y: bottom, size: 7, font: fonts.regular, color: rgb(0.35, 0.35, 0.35),
    });
    bottom += 11;
  }
  if (!tiny && opts.show_workspace_name && c.workspace_name) {
    page.drawText(fitText(fonts.regular, c.workspace_name, textW, 7), {
      x: x + pad, y: bottom, size: 7, font: fonts.regular, color: rgb(0.35, 0.35, 0.35),
    });
    bottom += 11;
  }
  if (!tiny && opts.show_location && c.location_path) {
    page.drawText(fitText(fonts.regular, c.location_path, textW, 8), {
      x: x + pad, y: bottom, size: 8, font: fonts.regular, color: rgb(0.2, 0.2, 0.2),
    });
  }
}

async function uploadPdf(sr: any, bytes: Uint8Array, name: string): Promise<string> {
  const file = new File([bytes], name, { type: "application/pdf" });
  const res = await sr.integrations.Core.UploadPrivateFile({ file });
  const uri = res?.file_uri ?? res?.data?.file_uri;
  const { signed_url } = await sr.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 900 });
  return signed_url;
}

serveActions({
  /** Render a PDF of labels for the given containers. */
  render_labels: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const ids = Array.isArray(payload.container_ids) ? payload.container_ids.slice(0, 200) : [];
    if (!ids.length) throw badRequest("container_ids required");
    const fmt = resolveFormat(payload);

    const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const locById = new Map(locations.map((l: any) => [l.id, l]));
    const containers = [];
    for (const id of ids) {
      const c = await requireContainer(ctx, id, "print_labels");
      containers.push({
        ...c,
        workspace_name: ctx.workspace.name,
        location_path: locById.get(c.location_id)?.path_text,
      });
    }

    const o = payload.options ?? {};
    const opts: LabelOpts = {
      show_title: o.show_title !== false,
      show_location: o.show_location !== false,
      show_category: o.show_category === true,
      show_workspace_name: o.show_workspace_name === true,
      instruction: typeof o.instruction === "string" ? o.instruction.slice(0, 60) : "Scan to view contents",
    };

    const doc = await PDFDocument.create();
    const fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    const perPage = fmt.cols * fmt.rows;
    for (let i = 0; i < containers.length; i += perPage) {
      const page = doc.addPage([fmt.page_w, fmt.page_h]);
      const batch = containers.slice(i, i + perPage);
      batch.forEach((c, idx) => {
        const col = idx % fmt.cols;
        const row = Math.floor(idx / fmt.cols);
        const x = fmt.margin_x + col * (fmt.label_w + fmt.gap_x);
        const yTop = fmt.page_h - fmt.margin_y - row * (fmt.label_h + fmt.gap_y);
        drawLabel(page, fonts, x, yTop - fmt.label_h, fmt.label_w, fmt.label_h, c, opts);
      });
    }
    const bytes = await doc.save();
    const url = await uploadPdf(ctx.sr, bytes, `labels-${Date.now()}.pdf`);

    if (payload.mark_printed === true) {
      for (const c of containers) {
        await ctx.sr.entities.Container.update(c.id, { label_status: "printed" });
      }
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "labels.rendered",
      metadata: { count: containers.length, format: String(payload.format ?? "letter_sheet") },
    });
    return { pdf_url: url, expires_in: 900, label_count: containers.length, pages: Math.ceil(containers.length / perPage) };
  },

  /** Alignment test page: outlines of every label cell for printer calibration. */
  render_test_page: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const fmt = resolveFormat(payload);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([fmt.page_w, fmt.page_h]);
    for (let row = 0; row < fmt.rows; row++) {
      for (let col = 0; col < fmt.cols; col++) {
        const x = fmt.margin_x + col * (fmt.label_w + fmt.gap_x);
        const yTop = fmt.page_h - fmt.margin_y - row * (fmt.label_h + fmt.gap_y);
        page.drawRectangle({
          x, y: yTop - fmt.label_h, width: fmt.label_w, height: fmt.label_h,
          borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.75,
        });
        page.drawText(`${row + 1}×${col + 1}`, {
          x: x + 4, y: yTop - 12, size: 8, font, color: rgb(0.6, 0.6, 0.6),
        });
      }
    }
    const bytes = await doc.save();
    const url = await uploadPdf(ctx.sr, bytes, `alignment-${Date.now()}.pdf`);
    return { pdf_url: url, expires_in: 900 };
  },

  /** Containers whose labels still need printing, in the caller's scope. */
  print_queue: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const accessible = await accessibleLocationIds(ctx);
    const containers = await ctx.sr.entities.Container.filter(
      { workspace_id: ctx.workspace.id, archived: false }, "-updated_date", 500,
    );
    const queue = containers.filter((c: any) =>
      c.label_status !== "printed" && (accessible === null || accessible.has(c.location_id))
    );
    return {
      queue: queue.map((c: any) => ({
        id: c.id, number_display: c.number ? formatNumber(c.number) : null,
        title: c.title, container_type: c.container_type, label_status: c.label_status,
      })),
    };
  },

  set_label_status: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const status = String(payload.status ?? "");
    if (!["not_printed", "queued", "printed"].includes(status)) throw badRequest("Invalid label status");
    const ids = Array.isArray(payload.container_ids) ? payload.container_ids.slice(0, 500) : [];
    let updated = 0;
    for (const id of ids) {
      await requireContainer(ctx, id, "print_labels");
      await ctx.sr.entities.Container.update(id, { label_status: status });
      updated++;
    }
    return { updated };
  },

  get_prefs: async (_payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, _payload.workspace_id);
    const profiles = await ctx.sr.entities.UserProfile.filter({ user_id: ctx.user.id });
    return { label_prefs: profiles[0]?.label_prefs ?? null };
  },

  set_prefs: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    if (typeof payload.label_prefs !== "object" || payload.label_prefs === null) {
      throw badRequest("label_prefs object required");
    }
    const profiles = await ctx.sr.entities.UserProfile.filter({ user_id: ctx.user.id });
    if (profiles[0]) await ctx.sr.entities.UserProfile.update(profiles[0].id, { label_prefs: payload.label_prefs });
    return { saved: true };
  },
});
