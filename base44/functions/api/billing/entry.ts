// api/billing — subscription state and purchase flows.
// Web: Stripe Checkout + Customer Portal (dormant until STRIPE_* secrets are
// set). Mobile: App Store / Play Store IAP receipts (dormant until store
// credentials are set). The WorkspaceSubscription record stays the single
// entitlement source of truth regardless of provider; downgrades never
// delete data.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, ApiError } from "../../../shared/http.ts";
import { requireMember } from "../../../shared/authz.ts";
import { logActivity } from "../../../shared/audit.ts";
import { getSubscription, effectivePlan, limitsFor, PRICING, PLAN_LIMITS } from "../../../shared/entitlements.ts";
import { stripeConfigured, stripeRequest, priceIdFor, seatPriceId } from "../../../shared/stripe.ts";
import { WEB_APP_URL } from "../../../shared/config.ts";

/** IAP product ids the mobile clients will register in the stores. */
export const IAP_PRODUCTS: Record<string, { plan: "household" | "business"; interval: "monthly" | "annual" }> = {
  "com.six47.findmybins.household.monthly": { plan: "household", interval: "monthly" },
  "com.six47.findmybins.household.annual": { plan: "household", interval: "annual" },
  "com.six47.findmybins.business.monthly": { plan: "business", interval: "monthly" },
  "com.six47.findmybins.business.annual": { plan: "business", interval: "annual" },
};

function iapConfigured(platform: "ios" | "android"): boolean {
  return platform === "ios"
    ? !!Deno.env.get("APPLE_IAP_ISSUER_ID") && !!Deno.env.get("APPLE_IAP_KEY")
    : !!Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT");
}

serveActions({
  get_billing: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "billing");
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    const plan = effectivePlan(sub);
    const limits = limitsFor(sub);
    return {
      plan,
      stored_plan: sub.plan,
      status: sub.status,
      trial_type: sub.trial_type ?? null,
      trial_ends_at: sub.trial_ends_at ?? null,
      billing_interval: sub.billing_interval ?? null,
      current_period_end: sub.current_period_end ?? null,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      payment_provider: sub.payment_provider ?? null,
      seats: plan === "business"
        ? {
          included: Math.max(PRICING.business.seats_included, sub.seats_included ?? 0),
          extra: sub.seats_extra ?? 0,
        }
        : null,
      storage: { bytes_used: sub.storage_bytes_used ?? 0, bytes_limit: limits.storage_bytes },
      ai_trial: plan === "free"
        ? { used: sub.ai_trial_actions_used ?? 0, total: limits.ai_trial_actions }
        : null,
      pricing: PRICING,
      limits: PLAN_LIMITS,
      providers: {
        stripe_configured: stripeConfigured(),
        ios_iap_configured: iapConfigured("ios"),
        android_iap_configured: iapConfigured("android"),
      },
    };
  },

  /** Web upgrade path: Stripe Checkout session. */
  start_checkout: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "billing");
    const plan = payload.plan as "household" | "business";
    const interval = payload.interval === "annual" ? "annual" : "monthly";
    if (!["household", "business"].includes(plan)) throw badRequest("plan must be household or business");
    if (!stripeConfigured()) {
      return { configured: false, message: "Payments aren't set up yet. Check back soon." };
    }
    const priceId = priceIdFor(plan, interval);
    if (!priceId) throw new ApiError(503, "stripe_misconfigured", `Missing price id for ${plan}/${interval}`);

    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    const params: Record<string, string> = {
      mode: "subscription",
      client_reference_id: ctx.workspace.id,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][workspace_id]": ctx.workspace.id,
      "metadata[workspace_id]": ctx.workspace.id,
      success_url: `${WEB_APP_URL}/billing?checkout=success`,
      cancel_url: `${WEB_APP_URL}/billing?checkout=canceled`,
    };
    const seats = Number(payload.seats_extra);
    if (plan === "business" && Number.isInteger(seats) && seats > 0) {
      const seatPrice = seatPriceId(interval);
      if (seatPrice) {
        params["line_items[1][price]"] = seatPrice;
        params["line_items[1][quantity]"] = String(Math.min(seats, 100));
      }
    }
    if (sub.stripe_customer_id) params.customer = sub.stripe_customer_id;
    else params.customer_email = ctx.user.email;

    const session = await stripeRequest("checkout/sessions", params);
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "subscription.checkout_started",
      metadata: { plan, interval },
    });
    return { configured: true, checkout_url: session.url };
  },

  /** Stripe Customer Portal for card changes, seat changes, cancellation. */
  open_portal: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "billing");
    if (!stripeConfigured()) {
      return { configured: false, message: "Payments aren't set up yet." };
    }
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    if (!sub.stripe_customer_id) throw badRequest("No billing account yet — upgrade first");
    const session = await stripeRequest("billing_portal/sessions", {
      customer: sub.stripe_customer_id,
      return_url: `${WEB_APP_URL}/billing`,
    });
    return { configured: true, portal_url: session.url };
  },

  /**
   * Mobile purchase path. The client buys the store product, then submits the
   * receipt here for server-side verification. Verification requires store
   * credentials; until they're wired, this reports unconfigured and changes
   * nothing.
   */
  apply_iap_receipt: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id, "billing");
    const platform = payload.platform === "ios" ? "ios" : payload.platform === "android" ? "android" : null;
    if (!platform) throw badRequest("platform must be ios or android");
    const productId = String(payload.product_id ?? "");
    if (!IAP_PRODUCTS[productId]) throw badRequest("Unknown product id");
    if (!iapConfigured(platform)) {
      return { configured: false, message: "In-app purchases aren't set up yet." };
    }

    // Wired later: verify against App Store Server API / Google Play Developer
    // API, extract expiry + original transaction id, then apply below.
    const verified = await verifyStoreReceipt(platform, payload);
    if (!verified.ok) throw new ApiError(402, "receipt_invalid");

    const { plan, interval } = IAP_PRODUCTS[productId];
    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    if (sub.id) {
      await ctx.sr.entities.WorkspaceSubscription.update(sub.id, {
        plan,
        status: "active",
        billing_interval: interval,
        payment_provider: platform === "ios" ? "apple" : "google",
        iap_product_id: productId,
        iap_original_transaction_id: verified.original_transaction_id,
        iap_purchase_token: verified.purchase_token,
        iap_expires_at: verified.expires_at,
        current_period_end: verified.expires_at,
      });
    }
    await logActivity(ctx.sr, {
      workspace_id: ctx.workspace.id, actor: ctx.user, action: "subscription.changed",
      metadata: { change: "iap_purchase", plan, interval, platform },
    });
    return { configured: true, plan, status: "active" };
  },
});

interface VerifiedReceipt {
  ok: boolean;
  expires_at?: string;
  original_transaction_id?: string;
  purchase_token?: string;
}

async function verifyStoreReceipt(platform: "ios" | "android", _payload: Record<string, any>): Promise<VerifiedReceipt> {
  // Placeholder until store credentials exist; iapConfigured() gates arrival here.
  console.error(`[billing] ${platform} receipt verification not implemented yet`);
  return { ok: false };
}
