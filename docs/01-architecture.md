# FindMyBins — Architecture Summary

Backend: Base44 (app `6a5fd45e9129f5171ccbb963`). Clients: React web (Vite) + React Native (Expo, iOS/Android). See `02-base44-gap-assessment.md` for why each decision was made.

## Repository layout (npm workspaces monorepo)

```
FindMyBins/
├── base44/                  # Backend source of truth
│   ├── entities/            # Entity JSON schemas (deny-all client RLS)
│   ├── functions/           # Deno backend functions (the only API surface)
│   ├── shared/              # authz.ts, entitlements.ts, numbering.ts, search.ts, audit.ts
│   └── auth/config.jsonc    # email/password + Google + Apple
├── apps/
│   └── app/                 # ONE universal Expo app (React Native + react-native-web)
│                            # → iOS, Android, and web from a single codebase (owner decision 2026-07-21).
│                            # Expo Router provides web URLs (incl. /q/<token>) and native deep links;
│                            # web build deployed via Base44 site hosting.
├── packages/
│   ├── core/                # Shared domain types, constants, role/permission tables, validation
│   └── api-client/          # Typed wrapper over base44.functions.invoke (platform-agnostic token storage)
└── docs/                    # Living deliverables
```

## Security architecture (single most important decision)

Base44 RLS cannot express workspace membership (Gap 1), so **clients never touch entities directly**:

1. Every entity ships `"rls": { "create": false, "read": false, "update": false, "delete": false }`.
2. Every read/write flows through a backend function: `createClientFromRequest(req)` → `auth.me()` (reject if absent) → `authorize(user, workspace, action, location?)` from `shared/authz.ts` → scoped `asServiceRole` query filtered by workspace/location **before** any data leaves the DB.
3. Client-submitted workspace IDs, roles, location IDs, plans, and prices are never trusted; the server derives them.
4. Denials are generic and constant-shape: QR resolution and record fetches return the same "not found or not accessible" response for nonexistent and unauthorized targets (no enumeration, no counts, no names).
5. Search/AI/reports/exports/dashboard counts run retrieval **after** permission filtering; AI context is built only from records the caller could read.
6. Attachments/photos are private-storage only; access is via short-lived signed URLs issued per request by an authorizing function (revocation = stop issuing).

## Entity model (≈22 entities)

Identity & access
- **UserProfile** — per-account settings, age attestation, theme, search-history prefs.
- **Workspace** — type (household/business/organization), settings, offline policy, deletion state (`deletion_requested_at`), template state.
- **WorkspaceMember** — `workspace_id`, `user_id`, role (`owner|admin|manager|contributor|viewer|billing_admin`), status. Exactly one owner enforced in code.
- **LocationGrant** — `workspace_id`, `member_id`, `location_id`, role. Business/Org only; inherited by all descendants.
- **Invitation** — hashed token, role, location scope, expiry, max/used count, domain restriction, approval flag, revoked flag.
- **JoinRequest** — for code/QR + approval flow.

Inventory
- **Location** — `workspace_id`, `parent_id` (null = root), name, denormalized `path` array + `path_text`, archived. Arbitrary depth; cycle checks in code.
- **Container** — `workspace_id`, `location_id`, `number` (display), `qr_token` (unguessable, permanent), type, title, description, category, tags, sizes, colors, label status (`not_printed|queued|printed`), archived, `custom` (object), `search_text`, sync metadata.
- **NumberReservation** — append-only (`workspace_id`, `number`, `container_id`); never deleted → numbers permanently reserved (Gap 3 design).
- **Item** — `workspace_id`, `container_id`, denormalized `location_id`, name (required), optional quantity (null ≠ 1), description, category, tags, notes, business fields (brand/model/serial/…), `custom`, `state` (`draft|confirmed`), `origin` (`manual|quicklist|ai_photo|voice|barcode|import`), archived, `search_text`.
- **CustomFieldDef** — scope (container/item), type (10 types), settings, archived (values preserved).
- **MediaAsset** — photo variants (thumb/medium/full/original), `file_uri`s (private), owner record refs, byte size (storage accounting), `deleted_at` (30-day recovery).
- **Attachment** — private `file_uri`, metadata, version list, archived/deleted state.

AI & capture
- **CaptureSession** — one photo/voice/barcode session; transcript text (audio deleted post-transcription), provider status, produced draft item IDs.

Operations
- **ActivityEvent** — audit log (actor, workspace, action, target, timestamp); never contains search query text; retention pruned by cron per plan.
- **SearchHistory** — per-user private entries; user-controlled deletion/disable/expiry; excluded from admin visibility by authz.
- **WorkspaceSubscription** — plan, trial dates, seat count, Stripe IDs, storage-used cache. Entitlement source of truth.
- **Notification** / **NotificationPref** / **PushToken**
- **Job** — import/export/report/purge jobs with chunked progress (5-min function limit).

## API surface (backend functions, ≈16 of 50 budget)

Domain routers (`{action, payload}` dispatch): `api/workspaces`, `api/members` (membership+invitations), `api/locations`, `api/containers`, `api/items`, `api/search`, `api/qr`, `api/capture` (AI photo/voice/barcode), `api/labels`, `api/files`, `api/reports`, `api/imports-exports`, `api/billing`, `api/notifications`, `api/sync`, `api/activity`.
Non-router: `webhooks/stripe`. Automations (cron): trial reminders, 30-day purge, audit retention, storage recalc.

## QR & deep links

- Label QR encodes only `https://<domain>/q/<qr_token>`; token is ≥128-bit random, never derived from number/workspace.
- Resolution: `api/qr` looks up token via service role → membership + location check → container payload, archived-state payload, or generic denial (identical for unknown tokens).
- Same URL serves iOS universal links, Android app links (pending Gap 4 validation), and web fallback; unauthenticated scans preserve destination through login. Manual number lookup available within a workspace.

## Numbering

Server-only allocation (Gap 3): next = max(reservation)+1 → insert reservation → re-query; deterministic winner on collision, loser retries. Display format `%03d` expanding beyond 999. Offline creations show *Pending Number* until sync assigns one. Admin renumber = new reservation, old one kept forever.

## Offline sync (mobile)

- Local Expo SQLite cache per workspace, AES-encrypted (key in SecureStore), wiped on sign-out; policy (revalidation window, photo/edit toggles, biometric) read from Workspace settings, Household default 30d / Business 7d.
- Delta pull via `api/sync` using per-entity `updated_date` cursors; mutation queue with client-generated UUIDs for idempotent replay; media upload queue.
- Explicit states: Online, Offline, Saved Locally, Waiting to Sync, Uploading, Synced, Needs Attention. Conflicts: last-write for harmless fields; review queue (both versions preserved) for quantity, archive-vs-edit, and incompatible moves.

## Search

Normalized `search_text` per record; keyword search = authz-scoped query + tokenized/fuzzy scoring + synonym table (Gap 8). NL search (paid) = scoped candidate retrieval → `InvokeLLM` with JSON schema citing record IDs → answer links real records, distinguishes exact/possible, admits no-result. History saved client-request-side per user prefs.

## Billing & entitlements

`WorkspaceSubscription` drives entitlements (free/household/business tables in `packages/core`), checked server-side in the shared module. Stripe Checkout/Portal via `api/billing`; `webhooks/stripe` (signature-verified) syncs state. No-card trials are internal state. Downgrade = read/search/scan/export preserved, creation & premium paused, nothing deleted. Storage accounting from MediaAsset/Attachment sums; warnings at 80/90/100%, uploads pause at 100%.

## Cross-cutting

- **Audit**: `shared/audit.ts` writes ActivityEvent in the same function call as the mutation.
- **AI safety**: all AI output lands as `state: draft`; confirmation is an explicit user action; uncertainty flagged; fair-use throttling per workspace in `api/capture`.
- **Analytics/logs**: event names + codes only; never inventory content, queries, tokens, or file URLs.
- **Theming/a11y**: shared design tokens in `packages/core`; light/dark with QR/photos never inverted; WCAG AA targets.
