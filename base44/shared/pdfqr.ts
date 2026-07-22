// Vector QR + text helpers for pdf-lib documents (no canvas, always black-on-white).

import QRCode from "npm:qrcode@1.5.4";
import { rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";

export function drawQrOnPage(page: PDFPage, text: string, x: number, y: number, size: number): void {
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

export function fitText(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + "…", size) > maxWidth) out = out.slice(0, -1);
  return out + "…";
}
