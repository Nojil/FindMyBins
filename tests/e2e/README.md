# End-to-end security & behavior tests

These run against the **live deployed backend** with real app users. They are the
direct security tests the spec requires — isolation is verified through the API,
never assumed from the UI.

| Script | Covers |
|---|---|
| `e2e-phase12a.mjs` | Owner flow: trial start, location hierarchy + path cascade, 8-way concurrent numbering, archive semantics, retired-number reservation, renumber rejection, move keeps number/QR, scoped invitation issuance. Writes `phase12-state.json` for part B. |
| `e2e-phase12b.mjs` | Viewer isolation: generic 404 before membership, 13+ gate, single-use tokens, location-grant scoping (list/count/direct-fetch/number-lookup), viewer write denial, billing visibility scoping. Requires a **fresh single-use invite token** in `phase12-state.json` and a verified second user. |
| `e2e-concurrency.mjs` | 10-way concurrent container creation → unique, contiguous numbers. |
| `e2e-phase3.mjs` | Items & media: null-quantity semantics, quick list, household vs business field policy, bulk move, quantity split, duplicate merge, 30-day recovery, private photo upload → signed URL → revocation on delete, storage accounting, viewer item/media isolation. Requires both test users verified and `phase12-state.json`. |
| `e2e-phase4.mjs` | QR + labels: owner/viewer/anonymous scan matrix, byte-identical denial for unknown vs unauthorized tokens, archived-scan state, label PDF render (Letter sheet) with mark-printed, print-queue exclusion, thermal alignment page, impossible-custom-format rejection, viewer print denial, label prefs. |
| `e2e-phase5.mjs` | Search + dashboards: exact/typo/synonym/multi-token matching, case-insensitivity, location filter, archived exclusion, viewer zero-hidden-matches, history privacy (cross-user invisibility incl. vs the owner, disable saving, delete, clear), dashboard count isolation and role-gated business extras. |
| `e2e-phase6.mjs` | AI capture + NL search: real vision pipeline (GenerateImage → private upload → analyze → drafts with confidence), drafts excluded from inventory until confirmed, confirm-with-edit / discard, NL answers citing only authorized records, viewer NL leak test, free-plan NL gate (402), household barcode rejection, business barcode suggestion + approved add. Costs a few AI credits per run. |
| `e2e-phase7.mjs` | Offline sync backend: scoped delta pull with policy + accessible set, viewer pull isolation, offline create with idempotent replay (one number, one QR), offline item via parent client_uuid, quantity / archive-vs-edit / incompatible-move conflicts preserving both versions, harmless stale edits applied last-write, cursor deltas, per-mutation viewer rejection. |
| `e2e-phase8.mjs` | Import/export/reports/attachments: CSV mapping detection, quoted-comma parsing, location auto-creation from paths, duplicate skip, item import by container title with quantity semantics, free-plan 402 + viewer 403 gates, full undo with numbers staying retired, stable-ID CSV export + viewer denial, workspace/missing-details PDFs with QR + viewer denial, attachment type validation, versioned replace, viewer generic 404, delete revoking access. |
| `e2e-phase10.mjs` | Lifecycle & hardening: activity log with retention window + viewer 403, recovery listing with 30-day purge deadlines, ownership transfer (typed-name gate, admin-only target, owner↔admin swap, ex-owner loses rights), workspace deletion window (members blocked, owner retains view, duplicate rejected, cancel restores), account-deletion guard, maintenance sweep execution without purging in-window records. |
| `e2e-phase9.mjs` | Billing: business/free snapshots (seats, pricing, AI trial, storage), viewer 403, unconfigured checkout/portal/IAP graceful messages, invalid plan + unknown IAP product 400, platform Stripe-Signature interception (401) + custom webhook unsigned refusal (503), billing-daily-sweep executes, downgrade preserves read access. |

## Running

```bash
npm install @base44/sdk        # in this directory or any parent
export FMB_TEST_PASSWORD=...   # test-user password
node e2e-phase12a.mjs
node e2e-concurrency.mjs
node e2e-phase12b.mjs          # after registering/verifying the 2nd user
```

Test users are `six47webservices+fmbtest@gmail.com` (owner) and
`six47webservices+fmbtest2@gmail.com` (viewer). OTP verification on first
registration is manual (check the inbox).

Notes
- Scripts are resumable: part A reuses the `Test Biz` workspace if it exists.
- The workspace contains a few duplicate-numbered containers created before the
  allocator's settle-and-verify fix — kept deliberately as regression debris;
  new allocations must still be unique and contiguous from the current max.
- The account's one-per-type business trial is already consumed by part A.
