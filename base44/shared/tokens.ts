// Unguessable identifiers. QR tokens are permanent per container; invitation
// tokens are stored only as SHA-256 hashes — the raw value exists solely in
// the delivered link or code.

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

/** ~131 bits of entropy for QR container tokens. */
export function newQrToken(): string {
  return randomBase62(22);
}

/** ~190 bits for invitation links. */
export function newInviteToken(): string {
  return randomBase62(32);
}

/** Short human-typable invite code (~46 bits) — always paired with admin approval. */
export function newInviteCode(): string {
  return randomBase62(8).toUpperCase();
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const QR_LINK_BASE = "https://findmybins.com/q/";
export const INVITE_LINK_BASE = "https://findmybins.com/join/";
