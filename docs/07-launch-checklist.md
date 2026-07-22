# Launch Checklist

Tracks what stands between the current build and a public release. Items marked **blocking** must be done before store submission.

## 1. Domain & deep links (blocking)

- [ ] Point `findmybins.com` at the app (Base44 custom domain, or a proxy fronting it).
- [ ] Serve `/.well-known/apple-app-site-association` (no extension, `application/json`, no redirect) with the app's Team ID + bundle `com.six47.findmybins`.
- [ ] Serve `/.well-known/assetlinks.json` with the Android package + release signing SHA-256.
- [ ] Verify a real scan opens the app on iOS and Android (currently unverified — Gap 4).
- [ ] Update `WEB_APP_URL` in `base44/shared/config.ts` and `WEB_APP_URL`/`QR_LINK_BASE` in `packages/core`.

**Note:** QR labels already encode `https://findmybins.com/q/<token>`. Labels printed before the domain is live will resolve only once it is — do not print production labels until this is done.

## 2. Billing (blocking for paid plans)

See `05-billing-wiring.md` for the full procedure. Summary:
- [ ] Choose Stripe path (Base44 native payments recommended — the platform intercepts `Stripe-Signature` requests).
- [ ] Create Stripe products/prices; set `STRIPE_*` secrets.
- [ ] Create IAP products in App Store Connect + Play Console; set store credentials; implement `verifyStoreReceipt()`.
- [ ] Add a client IAP library to `apps/app`.
- [ ] Create a dashboard **Workflow** to run `billing-daily-sweep` daily.

## 3. Scheduled jobs (blocking)

This app has Workflows enabled, so file-based cron automations are rejected. Both sweeps are deployed as HTTP functions and need Workflow triggers:
- [ ] `billing-daily-sweep` — daily (trial reminders, storage warnings).
- [ ] `maintenance-sweep` — daily (purges, audit retention, workspace deletion).

Until these are scheduled, nothing is purged and no reminders are sent. Both are idempotent and safe to run repeatedly.

## 4. Native builds

- [ ] `eas build` configuration + credentials for iOS and Android.
- [ ] On-device verification (not yet performed — all native paths are untested on hardware):
  - [ ] Camera QR scanning; permission denial + recovery.
  - [ ] Photo capture → variants → upload → AI analyze.
  - [ ] Offline: airplane-mode create with Pending Number, queue, reconnect, sync.
  - [ ] Conflict review screen with a real conflict.
  - [ ] Sign-out wipes the local cache.
  - [ ] Google and Apple sign-in via the auth-session flow.
- [ ] Label print test at Letter, A4, 4×6 thermal, 3×2, 2×1 — scan each printed label with a real camera.

## 5. Store submission

- [ ] Privacy Policy and Terms URLs (must exist and be reachable).
- [ ] Account-deletion instructions URL (Apple requirement) — the in-app flow exists (`delete_account`); document it publicly.
- [ ] App Privacy disclosures: camera, photo library, and (if voice ships later) microphone.
- [ ] Apple: Sign in with Apple is already offered — required since third-party sign-in is present.
- [ ] Screenshots, description, keywords, support URL.
- [ ] Closed testing with friends via TestFlight / Play internal testing (managed outside the product, per spec).

## 6. Accessibility pass

Implemented: semantic `Pressable`/`Text` controls, 48pt minimum touch targets, theme-aware contrast, system light/dark support, `accessibilityLabel` on the confirmation field, non-color status cues (icon + text on every badge and sync state), no motion-dependent affordances.

- [ ] VoiceOver (iOS) and TalkBack (Android) pass over: onboarding, tabs, container detail, scan, danger zone.
- [ ] Dynamic Type / font-scaling at 200% without clipping.
- [ ] Automated contrast audit of both themes.
- [ ] Keyboard-only navigation on web.

## 7. Pre-launch verification

- [ ] Run the full e2e suite (`tests/e2e/`, 10 files) against production — all currently green.
- [ ] Confirm the two log leaks stay fixed (`06-security-privacy-checklist.md` audit) after any new logging is added.
- [ ] Load-check search at a realistic inventory size (in-function scoring is O(n); watch >2000 items — Gap 8).
- [ ] Verify downgrade behavior end-to-end with a real Stripe cancellation.

## 8. Known deferrals (accepted)

| Item | Reason |
|---|---|
| MFA / passkeys | Owner decision — post-launch; platform gap |
| Voice inventory | Owner decision — post-launch |
| Offline media queue | Photos currently require connectivity |
| Client UI for CSV import/export, PDF reports, attachments | Backend complete + tested; UI not built |
| Members/locations management UI | Backend complete; only read-only views in client |
| Original-resolution photo retention toggle | Variants only today |
| Workspace templates | Backend model supports it; no template content shipped |
