# FindMyBins

**Scan It. Store It. Find It.** — Secure storage organization for households, businesses, and organizations. Create digital records of storage containers, print QR labels, scan to view or update, and search to find exactly which container and physical location holds an item.

## Structure

| Path | Purpose |
|---|---|
| `base44/` | Backend source of truth: entity schemas, Deno backend functions, auth config |
| `apps/app` | ONE universal Expo app (React Native + react-native-web) → iOS, Android, and web |
| `packages/core` | Shared domain types, role/entitlement tables, validation |
| `packages/api-client` | Typed client wrapper over Base44 backend functions |
| `tests/e2e` | Live-backend security & behavior test suites |
| `docs/` | Architecture, gap assessment, permission matrix, phase plan, billing wiring, security & launch checklists |

Web build is deployed to Base44 hosting: https://find-my-bins-1ccbb963.base44.app (will move to findmybins.com).

## Security model (read first)

Clients never access entities directly — every entity has deny-all RLS. All reads and writes go through backend functions that authenticate the caller, check workspace membership and location grants (`base44/shared/authz.ts`), and only then run scoped service-role queries. See `docs/01-architecture.md`.

## Development

```bash
npm install
npm run app             # Expo dev server (iOS/Android via Expo Go, press w for web)
npm run web             # web dev server directly
npm run web:deploy      # export web build + deploy to Base44 hosting
npm run backend:dev     # local backend functions
npm run entities:push   # deploy entity schemas
```

Requires a Base44 login (`npx base44 login`).
