# Testing the Mobile Apps

The iOS, Android, and web clients are one Expo codebase (`apps/app`). The app always talks to the **deployed Base44 backend** — there is no local backend to run.

## Which path do you need?

| | Expo Go | Development build (EAS) |
|---|---|---|
| Setup | Install an app, scan a QR | Cloud build, ~10–20 min first time |
| Camera QR scanning (in-app) | ✅ | ✅ |
| Photos → AI analysis | ✅ | ✅ |
| Offline cache & sync (SQLite) | ✅ | ✅ |
| Secure token storage | ✅ | ✅ |
| Google / Apple sign-in | ✅ | ✅ |
| Custom scheme `findmybins://` | ❌ (uses `exp://`) | ✅ |
| Universal / App Links (`findmybins.com/q/…`) | ❌ | ✅ *(also needs the domain + `/.well-known` files — see `07-launch-checklist.md`)* |
| In-app purchases | ❌ | ✅ (once wired) |

**Every native module this app uses ships inside Expo Go for SDK 57** — camera, sqlite, secure-store, image-picker, image-manipulator, network, linear-gradient, web-browser, linking. So start with Expo Go; you only need a build for deep links and store submission.

## Option 1 — Expo Go (start here)

1. Install **Expo Go** from the App Store / Play Store.
2. From the repo root:
   ```bash
   npm install
   npm run app          # expo start
   ```
3. iOS: scan the terminal QR with the Camera app. Android: scan it inside Expo Go.
4. Phone and computer must be on the same Wi-Fi. If the network blocks it (guest Wi-Fi, VPN, corporate):
   ```bash
   npm run app -- --tunnel
   ```

Sign in with the test account (`six47webservices+fmbtest@gmail.com`) or create a new one — registration emails a real OTP.

## Option 2 — Simulators / emulators

```bash
npm run ios       # iOS Simulator (macOS + Xcode)
npm run android   # Android emulator (Android Studio)
```

Good for layout, navigation, and offline behaviour. **Not** good for scan testing: the iOS Simulator has no camera at all, and the Android emulator's virtual camera makes QR scanning awkward. Use a real phone for anything camera-related.

## Option 3 — Development build (for deep links / store prep)

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --profile development --platform ios      # or android
```

Install the resulting build on the device, then `npm run app` connects to it like Expo Go. This is what you need to test `findmybins://` links, universal links, and later IAP.

## What to actually exercise on device

Nothing native has been verified on hardware yet, so this is the highest-value list:

- [ ] **Camera scan** — print a label (`Print label` on any container → PDF), then scan it from the Scan tab. Also check permission denial and recovery.
- [ ] **Photos → AI** — container detail → Take photo → Analyze with AI → confirm/discard the drafts.
- [ ] **Offline** — turn on airplane mode, create a container (should save with *Pending Number*), add items, re-enable network, watch the SyncPill go Waiting → Synced and the number get assigned.
- [ ] **Conflicts** — edit the same item's quantity on web and offline on the phone, then sync; the conflict screen should offer both versions.
- [ ] **Sign-out wipes cache** — sign out, confirm cached containers are gone.
- [ ] **Google / Apple sign-in** — the auth-session browser should close and return you signed in.
- [ ] **Appearance** — More → Appearance; switch System/Light/Dark and confirm shadows read correctly on a real screen.
- [ ] **Text scaling** — set the device font to its largest size and check nothing clips.

## Notes and gotchas

- **Deep-link scheme differs in Expo Go.** It uses `exp://…/--/auth-callback` instead of `findmybins://auth-callback`; the OAuth callback already accepts both, so social sign-in works in Expo Go.
- **Universal links won't open the app** until `findmybins.com` serves the `/.well-known` files. Until then, scanning a printed label with the phone's *system* camera opens the web app — in-app scanning works fine.
- **Monorepo:** `apps/app/metro.config.js` watches the workspace root so edits to `packages/core` and `packages/api-client` hot-reload. Don't delete it.
- **Keep dependencies SDK-aligned.** Run `npx expo install --check` after adding packages; mismatched native modules fail confusingly inside Expo Go. Use `npx expo install <pkg>`, not `npm install <pkg>`.
- **Verify a native bundle without a device** at any time:
  ```bash
  npx expo export --platform ios      # or android
  ```
  This catches resolution/config breakage in ~1 minute. Re-run `npm run web:export` afterwards, since it overwrites `dist/`.
