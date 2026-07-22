# Security & Privacy Checklist

Status legend: ✅ implemented and covered by an automated test · ⚠️ implemented, needs manual/on-device verification · ⛔ platform gap (see `02-base44-gap-assessment.md`)

## Authorization

| Requirement | Status | Where |
|---|---|---|
| Deny-all RLS on every entity; clients never touch entities directly | ✅ | all `base44/entities/*.json` |
| Workspace membership enforced on all workspace data | ✅ | `shared/authz.ts` `requireMember` |
| Location permission inherited by zones/containers/items/media/reports | ✅ | `accessibleLocationIds`, `requireLocationCap` |
| Owner-only billing, ownership transfer, permanent deletion | ✅ | capability table in `authz.ts` |
| Export is a distinct permission from view | ✅ | `api/imports export_csv` (viewer 403) |
| No client-trusted workspace/role/location IDs | ✅ | every action re-derives from the caller |
| Immediate revocation when a member is removed | ✅ | membership checked per request |
| Audited permission and ownership changes | ✅ | `shared/audit.ts`, `critical: true` events |

## Information disclosure

| Requirement | Status | Notes |
|---|---|---|
| QR resolution returns nothing before authorization | ✅ | `api/qr` |
| Unknown vs unauthorized are **byte-identical** denials | ✅ | verified in `e2e-phase4.mjs` |
| Unauthenticated scan returns bare 401 with no metadata | ✅ | preserves destination through login |
| Dashboard/search counts never reveal hidden inventory | ✅ | `e2e-phase5.mjs` count isolation |
| AI receives only permission-filtered context | ✅ | retrieval before `InvokeLLM`; citations re-validated |
| Attachment/media URLs die with permission | ✅ | per-request signed URLs only, 10-min expiry |
| No cross-workspace number or object leakage | ✅ | all queries workspace-scoped |

## Secrets, tokens, logs

| Requirement | Status | Notes |
|---|---|---|
| No secrets in client code | ✅ | only the public `appId` ships |
| QR tokens ≥128-bit, permanent, never derived from number/workspace | ✅ | `shared/tokens.ts` (22 chars base62) |
| Invitation tokens stored only as SHA-256 hashes | ✅ | raw value returned once to the inviter |
| Invitation tokens unguessable, expiring, revocable, use-capped | ✅ | `e2e-phase12b.mjs` |
| **Logs never contain private search text** | ✅ | `safeError()` — see audit below |
| **Logs never contain raw invite tokens or signed URLs** | ✅ | `safeError()` — see audit below |
| Analytics never receive inventory/photos/queries/tokens | ✅ | no analytics SDK wired; policy documented |

### Log-sanitization audit (2026-07-22)

Every `console.*` call in `base44/` was reviewed. Two **real leaks** were found and fixed:

1. `api/search` logged the raw error from the failing `SearchHistory.create()` call. Axios-style SDK errors echo the request body (`config.data`) — which contains `query_text`. That would have written **private search queries** to server logs, violating the "never log private search text" rule.
2. `api/members` logged the raw error from a failed invitation email. That request body contains the email HTML, which embeds the **raw, still-valid invitation token**.

Both now use `safeError()` (`shared/http.ts`), which returns only the error's type and HTTP status and never the error object. The same sanitizer was applied to `api/capture` (signed photo URLs in the failing request), `api/files` (file URIs), `stripe-webhook`, and `shared/audit.ts`. No `console.*` call in the codebase now passes a raw error or a request payload.

## Data lifecycle

| Requirement | Status | Notes |
|---|---|---|
| 30-day recovery for items, photos, documents | ✅ | `api/activity recovery_list`, restore actions |
| Deleted media keeps counting toward storage until purged | ✅ | released by `maintenance-sweep` |
| Workspace deletion: typed confirmation + 30-day window + member blocking + restore | ✅ | `e2e-phase10.mjs` |
| Admins notified of deletion requests | ✅ | `request_workspace_deletion` |
| Ownership transfer: admin-only target, typed confirmation, both parties notified, audited | ✅ | `e2e-phase10.mjs` |
| Account deletion blocked while owning workspaces | ✅ | `account_deletion_status`, `delete_account` |
| Audit retention: Free 30d / Household 1y / Business 3y; critical events exempt | ✅ | `maintenance-sweep` |
| Container numbers permanently retired after archive/purge | ✅ | append-only `NumberReservation` |
| Voice audio auto-deleted after transcription | ⛔ | voice deferred to post-launch (owner decision) |

## Authentication

| Requirement | Status | Notes |
|---|---|---|
| Email/password, Google, Apple | ✅ | Base44-managed OAuth for both providers |
| Email verification via OTP | ✅ | |
| Age gates: 18+ to own, 13+ to join | ✅ | enforced server-side |
| MFA / passkeys | ⛔ | **deferred post-launch** (owner decision; platform gap) |
| Passwordless email links | ⛔ | not offered by Base44 |
| Re-authentication before destructive actions | ⚠️ | typed-name confirmation is enforced **server-side**; a fresh credential re-prompt is a client responsibility and is not yet implemented |
| Biometric local unlock (mobile) | ⚠️ | offline policy flag exists; `expo-local-authentication` not yet wired |

## Known gaps to accept or close before public launch

1. **MFA** — deferred by decision. Business owners cannot yet require MFA.
2. **Re-authentication prompt** — add a password/biometric re-prompt in the client before the danger zone actions.
3. **Voice inventory** — deferred; the audio-deletion guarantee is unexercised.
4. **Universal links** — `/.well-known` files must be served from findmybins.com before iOS/Android link interception works.
5. **Rate limiting** — no per-IP/per-user throttle on auth or QR resolution beyond the AI fair-use cap. Consider adding before public launch to slow token brute-forcing (tokens are 128-bit, so this is defense-in-depth, not a hole).
