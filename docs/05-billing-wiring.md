# Billing Wiring Guide

Everything in Phase 9 is **implemented and deployed** but dormant until credentials are set. Nothing here requires code changes — only Base44 secrets and store/Stripe configuration. The `WorkspaceSubscription` entity is the single entitlement source of truth regardless of provider; entitlement checks live in `base44/shared/entitlements.ts` and are enforced server-side (never UI-only). Downgrades never delete data.

## Current live behavior (unconfigured)

- `api/billing get_billing` — works now; returns plan, seats, storage, AI-trial usage, pricing, and a `providers` block reporting each rail as unconfigured.
- `start_checkout` / `open_portal` / `apply_iap_receipt` — return `{ configured: false, message }` gracefully; the client shows a "coming soon" note and never dead-ends.
- Trials (`start_trial`) — fully functional now, no payment method required (14 days, one per type per account).
- `billing-daily-sweep` — deployed HTTP function; runs the trial-reminder (7/3/1/expiry) and storage-warning (80/90/100%) logic idempotently. Needs a recurring trigger (see below).

## A. Stripe (web)

### Recommended: Base44 native payments
Base44 **intercepts any request carrying a `Stripe-Signature` header** at the platform level (verified: returns 401 "No Stripe webhook secret configured for this app" until set). This means Stripe's webhook deliveries are handled by Base44's own payments integration — a custom webhook function at a `base44.app` URL can never receive real Stripe events. Configure Stripe via the Base44 dashboard payments setup (docs.base44.com → Setting up payments). Then adapt `api/billing` to read the platform's payment/subscription state if it differs from our entity, or keep our entity synced via the platform's mechanism.

### Alternative: our own Stripe keys (direct REST)
If self-managing Stripe, `api/billing` already calls the Stripe REST API directly. Set these secrets:

```bash
base44 secrets set STRIPE_SECRET_KEY sk_live_xxx
base44 secrets set STRIPE_WEBHOOK_SECRET whsec_xxx
base44 secrets set STRIPE_PRICE_HOUSEHOLD_MONTHLY price_xxx
base44 secrets set STRIPE_PRICE_HOUSEHOLD_ANNUAL  price_xxx
base44 secrets set STRIPE_PRICE_BUSINESS_MONTHLY  price_xxx
base44 secrets set STRIPE_PRICE_BUSINESS_ANNUAL   price_xxx
base44 secrets set STRIPE_PRICE_SEAT_MONTHLY      price_xxx
base44 secrets set STRIPE_PRICE_SEAT_ANNUAL       price_xxx
```

The moment `STRIPE_SECRET_KEY` exists, `start_checkout` creates real Checkout sessions and `open_portal` opens the Customer Portal. Our `stripe-webhook` function (signature-verified, self-contained) handles `customer.subscription.{created,updated,deleted}` and `invoice.payment_failed` — **but** because the platform shadows `Stripe-Signature` requests, it only receives events if Stripe posts to a non-`base44.app` URL that proxies to it (e.g., via the custom domain). Prefer native payments unless you control that proxy. Products/prices to create in Stripe: Household $4.99/mo · $49/yr, Business $19/mo · $190/yr, extra seat $2/mo · $20/yr.

## B. In-app purchases (mobile)

`api/billing apply_iap_receipt` accepts a store receipt, verifies it server-side, and updates the subscription. Product IDs are already defined in `api/billing` (`IAP_PRODUCTS`):

```
com.six47.findmybins.household.monthly | .household.annual
com.six47.findmybins.business.monthly  | .business.annual
```

To wire:
1. Create those products in App Store Connect and Google Play Console.
2. Add a client IAP library (e.g. `expo-in-app-purchases` / RevenueCat) to `apps/app`, buy the product, and submit the receipt to `apply_iap_receipt`.
3. Set store verification credentials as secrets, then implement `verifyStoreReceipt()` in `api/billing/entry.ts` against the App Store Server API / Google Play Developer API:

```bash
base44 secrets set APPLE_IAP_ISSUER_ID xxx
base44 secrets set APPLE_IAP_KEY "$(cat AuthKey.p8)"
base44 secrets set GOOGLE_PLAY_SERVICE_ACCOUNT "$(cat service-account.json)"
```

`iapConfigured()` gates arrival at verification, so until the secrets exist the endpoint reports unconfigured and changes nothing.

## C. Recurring sweep trigger

`billing-daily-sweep` is deployed as an HTTP function (this app has Workflows enabled, which disables file-based cron automations). Attach a daily trigger by creating a **Workflow** in the Base44 dashboard that invokes `billing-daily-sweep` on a schedule, or call it from any external scheduler. It's idempotent (per-subscription markers), so duplicate runs are safe.

## D. Go-live checklist
- [ ] Choose Stripe path (native payments vs own keys) and set secrets/products.
- [ ] Create IAP products + set store verification secrets + implement `verifyStoreReceipt`.
- [ ] Add client IAP purchase library to `apps/app`.
- [ ] Create the daily Workflow for `billing-daily-sweep`.
- [ ] Update `WEB_APP_URL` in `base44/shared/config.ts` when moving to findmybins.com.
- [ ] Test: upgrade, downgrade (data preserved), seat change, trial→paid, payment failure → past_due.
