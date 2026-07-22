# FindMyBins — Implementation Phases

Each phase ends runnable and tested; security tests land with the feature, not after. Definition-of-done criteria from the build prompt are mapped at the end.

## Phase 0 — Foundations (repo, schemas, authz core)
Monorepo (npm workspaces): `apps/web`, `apps/mobile`, `packages/core`, `packages/api-client`. All entity schemas with deny-all RLS pushed. `shared/authz.ts`, `entitlements.ts`, `audit.ts`. Auth config (email/password + Google + Apple). Test harness for backend functions (`base44 dev` + integration tests). Design tokens (light/dark).

## Phase 1 — Identity, workspaces, membership
Onboarding (auth → age/terms → workspace type → template/blank). Workspace CRUD, roles, one-owner invariant, ownership transfer (reauth), account-deletion block while owning. Invitations (email/link/code+approval; hashed, expiring, revocable tokens), join requests. Validate SendEmail-to-nonusers (Gap 7). Templates (suggestions only, no fake inventory).
**Tests:** cross-workspace isolation, invitation token expiry/revocation, role escalation attempts.

## Phase 2 — Locations, containers, numbering
Location hierarchy (arbitrary depth, cycle prevention, path denormalization). Container CRUD (all types, one model), archiving (number+QR preserved, Archived filter). Numbering allocator with concurrency test (Gap 3). Location permissions (LocationGrant + inheritance) for Business/Org. Container moves across permission scopes with warning + audit.
**Tests:** concurrent numbering, archived-number reservation, location access isolation, move-across-scopes.

## Phase 3 — Items & manual entry methods
Item CRUD (name-only minimum, null-quantity semantics), quick list → individual items, photos without AI (private storage, variants, storage accounting), More Details (household) vs business fields, bulk/partial moves, copy, split, duplicate merge. Three-step container creation flow on web + mobile shells.
**Tests:** quantity semantics, media authorization, storage accounting.

## Phase 4 — QR, deep links, labels, printing
QR tokens + `api/qr` resolution (generic denial), web `/q/<token>` route, login-preserving redirect. Universal/app links (validate Gap 4 early; fallback plan). Label designer + setup wizard (Letter/A4/thermal/custom), PDF via `pdf-lib`, print queue, alignment/test pages, high-contrast QR always.
**Tests:** QR denial without permission, enumeration resistance, deep-link return after login, label scans at supported sizes.

## Phase 5 — Search & dashboards
`search_text` maintenance, keyword search (typo/synonym scoring), filters, archived filter. Search history (private, user-controlled). Household/Business dashboards, mobile bottom nav + global Add, web sidebar, role-aware navigation. Count isolation (dashboards never leak unauthorized counts).
**Tests:** search authorization & count isolation, history privacy.

## Phase 6 — AI capture & NL search (needs Builder plan)
AI photo analysis → draft items (uncertainty marked, approval required). NL search (paid) over permission-filtered candidates with cited records. Business barcode scanning (UPC/EAN/ISBN) with confirmation. Fair-use throttling + owner notification. Free-plan 5-action AI trial metering.
**Voice inventory: deferred to post-launch (owner decision 2026-07-21); CaptureSession entity already models it.**
**Tests:** AI context authorization, draft-only writes, trial metering.

## Phase 7 — Mobile offline & sync
Encrypted SQLite cache, delta sync cursors, idempotent mutation queue, media queue, Pending Number flow, offline QR resolution from cache, conflict review UI (both versions preserved), sync-state indicators, offline policy enforcement (revalidation windows, biometric, wipe on sign-out).
**Tests:** offline create → server numbering, conflict/retry, cache expiry, sign-out wipe.

## Phase 8 — Import/export, reports, attachments
CSV import wizard (map → validate → duplicates → preview → confirm → summary → full undo) honoring location permissions; chunked jobs. CSV export (distinct permission, stable IDs). PDF reports (workspace/location/container/category/search/archive/missing-details/recent-changes; branding options). Attachments (validated types, versions, preview/download/rename/replace/archive/delete, signed-URL revocation).
**Tests:** CSV validation/duplicates/undo, PDF authorization, attachment URL revocation.

## Phase 9 — Billing, storage, notifications
Stripe checkout/portal + webhook sync, no-card trials (14-day, one per type per account, 7/3/1-day reminders), seat management, downgrade behavior (nothing deleted, creation paused), storage warnings 80/90/100% + upload pause. Notification center (in-app/push/email), security notifications, optional reminders (default off), per-user-per-workspace prefs. Expo push.
**Tests:** upgrade/downgrade/trial/seat flows, storage limits, entitlement enforcement server-side.

## Phase 10 — Recovery, audit, hardening, launch
30-day recovery (items/media/docs), workspace deletion flow (reauth + typed confirmation + 30-day window + member blocking), permanent deletion with retained numbers. Audit retention pruning per plan. Accessibility pass (keyboard/screen reader/scaling/contrast/reduced motion), error/empty/loading/denied states everywhere, log sanitization audit, full security test suite run, app-store checklist, deployment docs.

## Definition-of-done mapping
3-minute first container → P1–P4 · camera-scan to container → P4 · unauthorized scan reveals nothing → P4 · search with exact location → P5 · household simple / business detailed → P3 · all entry methods with AI confirmation → P6 · offline core flows → P7 · unique permanent numbers → P2 · import/export/reports/billing/recovery → P8–P10 · security tested directly → every phase · platform parity → P0 shared packages onward · no dead UI → P10 gate.

## Decisions (owner, 2026-07-21)
1. **MFA**: deferred to post-launch (Gap 2).
2. **Voice inventory / speech-to-text**: deferred to post-launch (Gap 6).
3. **Custom domain**: `findmybins.com` for QR links and universal links (Gap 4).
4. **Stripe account** availability for Phase 9: still open.
