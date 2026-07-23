// api/auth-handoff — hands a freshly issued OAuth token from the browser to
// the native app without a deep link.
//
// Why this exists: Base44 rejects custom schemes as redirect domains, so
// native sign-in must return to an https page. Getting the token from that
// page back into the app via `exp://` / `findmybins://` proved unreliable —
// in Expo Go the scheme reloads the whole project and the token is lost.
//
// Instead the app generates an unguessable id, the browser stores the token
// under it here, and the app polls to claim it. Records are single-use and
// expire in two minutes.
//
// Both actions are intentionally UNAUTHENTICATED: the app has no session yet,
// and the browser page is not a Base44 client. The id is the only secret, so
// it must be long and random, it is stored only as a hash, and a claim
// consumes the record.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny } from "../../../shared/http.ts";
import { sha256Hex } from "../../../shared/tokens.ts";

const TTL_MS = 120_000;
/** Matches the app's generator: 32 base62 characters (~190 bits). */
const ID_PATTERN = /^[0-9A-Za-z]{32}$/;

serveActions({
  /** Called by the relay page in the browser once the token is in hand. */
  store: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole;

    const id = String(payload.handoff_id ?? "");
    const token = String(payload.access_token ?? "");
    if (!ID_PATTERN.test(id)) throw badRequest("Invalid handoff id");
    if (!token || token.length > 4096) throw badRequest("Invalid token");

    const handoff_hash = await sha256Hex(id);
    // One record per id; a repeat store (page reload) replaces it.
    const existing = await sr.entities.AuthHandoff.filter({ handoff_hash });
    for (const r of existing) await sr.entities.AuthHandoff.delete(r.id).catch(() => {});

    await sr.entities.AuthHandoff.create({
      handoff_hash,
      access_token: token,
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      claimed: false,
    });
    return { stored: true };
  },

  /** Polled by the app. Returns the token at most once. */
  claim: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole;

    const id = String(payload.handoff_id ?? "");
    if (!ID_PATTERN.test(id)) throw deny();

    const records = await sr.entities.AuthHandoff.filter({ handoff_hash: await sha256Hex(id) });
    const record = records[0];
    // Pending is a normal state while the user is still at the provider.
    if (!record) return { status: "pending" };
    if (record.claimed || new Date(record.expires_at) <= new Date()) {
      await sr.entities.AuthHandoff.delete(record.id).catch(() => {});
      return { status: "expired" };
    }
    // Single use: consume before returning.
    await sr.entities.AuthHandoff.delete(record.id).catch(() => {});
    return { status: "ready", access_token: record.access_token };
  },
});
