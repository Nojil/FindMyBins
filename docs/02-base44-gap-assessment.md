# Base44 Capability & Gap Assessment

Date: 2026-07-21 · App ID: `6a5fd45e9129f5171ccbb963` · Sources: docs.base44.com (verified 2026-07-21) and the CLI-installed skill references in `.agents/skills/`.

## Confirmed capabilities

| Requirement | Base44 capability | Status |
|---|---|---|
| Database | NoSQL entities (Mongo-compatible operators), JSON-schema definitions, built-in `id`, `created_date`, `updated_date`, `created_by`, soft-delete `is_deleted` | ✅ |
| Server code | Deno serverless functions, `Deno.serve`, npm imports, HTTP endpoints + `base44.functions.invoke()` | ✅ (max **50 functions**, **5-min** execution) |
| Auth providers | Email/password (with OTP verification), Google, Apple, Microsoft, Facebook, SSO | ✅ |
| External clients | `@base44/sdk` works in custom React (Vite) and React Native/Expo; token via `setToken` for non-browser storage | ✅ |
| Row/field-level security | Declarative RLS/FLS in entity schemas | ⚠️ Limited (see Gap 1) |
| File storage | `UploadFile` (public), `UploadPrivateFile` + `CreateFileSignedUrl` (expiring links) | ✅ |
| AI — text/vision | `InvokeLLM` (structured JSON, `file_urls` for image context), AI Gateway (OpenAI-compatible, for agent loops in backend functions) | ✅ |
| AI — image generation | `GenerateImage` | ✅ (not needed at launch) |
| Document extraction | `ExtractDataFromUploadedFile` | ✅ (useful for CSV/receipt flows) |
| Scheduled jobs | Cron + interval automations in `function.jsonc` | ✅ |
| Entity event triggers | Fire on single-record create/update/delete (not bulk ops) | ✅ with caveat |
| Email | `Core.SendEmail` | ⚠️ Documented as "to registered users" (see Gap 7) |
| Payments | Stripe integration documented at app level | ⚠️ Per-workspace subscriptions are custom work (see Gap 5) |
| Secrets | `base44 secrets set`, exposed as env vars in functions | ✅ |
| Web hosting | Static SPA deploy, custom domains + HTTPS | ✅ (validate `/.well-known` serving, Gap 4) |

## Gaps and mitigations

### Gap 1 — RLS cannot express workspace/location membership (critical, mitigated by architecture)
RLS conditions only compare record fields against the current user's attributes (`{{user.email}}`, `{{user.id}}`, `{{user.role}}`, `{{user.data.*}}`). There is **no cross-entity lookup**, so "user is a member of the workspace this record belongs to" and location-grant inheritance are inexpressible in RLS.

**Mitigation (adopted):** Deny-all RLS on every inventory entity (`create/read/update/delete: false` for clients). All data access goes through backend functions: `createClientFromRequest(req)` → `auth.me()` → authorization check against `WorkspaceMember`/`LocationGrant` → scoped `asServiceRole` queries. One shared authorization module in `base44/shared/` is the single enforcement point. This also satisfies the spec's "authorize before retrieval" rule for search/AI.

### Gap 2 — No MFA/TOTP, passkeys, or passwordless email links (needs product decision)
Base44 auth config documents provider toggles only. No TOTP, no passkeys, no magic-link login. OTP exists for email verification/registration.

**Decision (owner, 2026-07-21): MFA deferred to post-launch.** Launch with email/password + Google + Apple. Biometric *local* unlock on mobile via `expo-local-authentication` (client-side, achievable). Passwordless email links remain a platform gap.

### Gap 3 — No unique constraints or atomic counters (container numbering)
Entity schemas document no unique indexes; the SDK exposes no `findOneAndUpdate`-style atomic ops.

**Mitigation (adopted):** Numbers are allocated **only server-side** in one function path: append-only `NumberReservation` records (`workspace_id` + `number`), collision detection by post-insert re-query with deterministic winner (lowest record `id` keeps the number; loser retries with next). Reservations are never deleted → archived/purged numbers stay permanently reserved. Must be covered by a concurrency test.

### Gap 4 — Universal links / app links need `/.well-known` on the QR domain (validate early)
QR codes carry `https://<domain>/q/<token>`. iOS/Android link interception requires `apple-app-site-association` and `assetlinks.json` served from that domain. Not yet confirmed that Base44 static hosting serves `/.well-known/*` with correct content types.

**Decision (owner, 2026-07-21): custom domain `findmybins.com`.** QR links use `https://findmybins.com/q/<token>`. Validate `/.well-known` serving on Base44 hosting in Phase 4; fallback is domain fronting (e.g., Cloudflare) serving the well-known files and proxying the rest to Base44. Web fallback works regardless.

### Gap 5 — Per-workspace billing is custom work
Base44's Stripe docs cover app-level payments; FindMyBins bills per workspace with seat add-ons and no-card trials.

**Mitigation (adopted):** Internal `WorkspaceSubscription` entity is the entitlement source of truth (trials need no Stripe object). Stripe Checkout/Customer Portal launched from a backend function; a dedicated `webhooks/stripe` function (signature-verified) updates the subscription record. Entitlement checks live in the shared authorization module — never UI-only.

### Gap 6 — No built-in speech-to-text (needs provider decision)
Core integrations include no transcription. ElevenLabs (catalog) and custom OpenAPI integrations exist; both require the Builder plan or higher.

**Decision (owner, 2026-07-21): voice inventory deferred to post-launch.** When revived: voice audio → `UploadPrivateFile` → backend function calls a transcription provider (OpenAI or ElevenLabs via custom integration) → LLM structures transcript into item drafts → **delete audio** on success (fully in our control). Will need a provider choice + API key as a Base44 secret. The CaptureSession entity already models the flow.

### Gap 7 — `SendEmail` documented as "to registered users" (invitation emails)
Workspace invitations go to addresses that may not have accounts yet.

**Mitigation:** Validate empirically in Phase 1. The SDK also has `auth.inviteUser()`. Fallback: Resend integration (documented) for arbitrary recipients. Invitation *security* never depends on email: tokens are hashed at rest, unguessable, expiring, revocable.

### Gap 8 — No full-text/typo-tolerant search engine
Only Mongo-style filters; no documented text indexes.

**Mitigation (adopted):** Maintain a normalized `search_text` field on containers/items (name, description, category, tags, notes, searchable custom fields). Keyword search = scoped service-role query + in-function normalization, token matching, and edit-distance/n-gram scoring + synonym table. NL search (paid) = permission-filtered candidate retrieval **first**, then `InvokeLLM` with structured output citing record IDs. Performance at large inventory sizes is a watch item.

### Gap 9 — Push notifications not provided by Base44
**Mitigation:** Expo Push API called from backend functions; `PushToken` entity per user/device. Email + in-app notifications cover the rest.

### Gap 10 — PDF generation not built in
**Mitigation:** `pdf-lib` + a QR encoder via npm imports inside Deno functions for labels and reports. 5-minute limit → chunk very large reports/imports into job records processed incrementally.

### Platform-plan dependency (verify)
AI integrations, catalog/custom integrations require **Builder plan or higher** on Base44. Verify the account plan before Phase 6 (AI) and the transcription integration. Function count (≈16 planned of 50) and execution limits are otherwise comfortable.

## Explicitly not invented
No assumptions are made about: Base44-side MFA, magic links, unique indexes, text search indexes, webhooks-out (except documented connector webhooks), or per-workspace billing primitives. Everything above marked "adopted" uses only documented behavior.
