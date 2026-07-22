// stripe-webhook — the ONLY writer of Stripe-derived subscription state.
// Every event must carry a valid Stripe signature; without the webhook secret
// configured this endpoint refuses everything. Direct URL for the Stripe
// dashboard: https://base44.app/api/apps/<app-id>/functions/stripe-webhook
// (The reserved path `webhooks/stripe` is shadowed by Base44's own native
// Stripe handler, so this custom handler uses a distinct name.)

import { createClientFromRequest } from "npm:@base44/sdk";
import { verifyStripeSignature, planForPriceId } from "../../shared/stripe.ts";
import { safeError } from "../../shared/http.ts";
import { logActivity } from "../../shared/audit.ts";

Deno.serve(async (req: Request) => {
  const rawBody = await req.text();
  const configured = !!Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!configured) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const valid = await verifyStripeSignature(rawBody, req.headers.get("Stripe-Signature"));
  if (!valid) {
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }

  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "bad_payload" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const s = event.data.object;
        const workspaceId = s.metadata?.workspace_id;
        if (!workspaceId) break;
        const subs = await sr.entities.WorkspaceSubscription.filter({ workspace_id: workspaceId });
        if (!subs[0]) break;

        let plan: string | undefined;
        let interval: string | undefined;
        let seatsExtra = 0;
        for (const item of s.items?.data ?? []) {
          const mapped = planForPriceId(item.price?.id ?? "");
          if (mapped?.seat) seatsExtra = item.quantity ?? 0;
          else if (mapped?.plan) { plan = mapped.plan; interval = mapped.interval; }
        }
        const status = ["active", "trialing", "past_due"].includes(s.status)
          ? (s.status === "trialing" ? "active" : s.status)
          : s.status === "canceled" ? "canceled" : "past_due";

        await sr.entities.WorkspaceSubscription.update(subs[0].id, {
          ...(plan ? { plan } : {}),
          status,
          ...(interval ? { billing_interval: interval } : {}),
          seats_extra: seatsExtra,
          payment_provider: "stripe",
          stripe_customer_id: typeof s.customer === "string" ? s.customer : subs[0].stripe_customer_id,
          stripe_subscription_id: s.id,
          cancel_at_period_end: !!s.cancel_at_period_end,
          current_period_end: s.current_period_end
            ? new Date(s.current_period_end * 1000).toISOString()
            : subs[0].current_period_end,
          // A real paid subscription supersedes any internal trial.
          trial_type: null,
          trial_ends_at: null,
        });
        await logActivity(sr, {
          workspace_id: workspaceId, action: "subscription.changed",
          metadata: { via: "stripe_webhook", event: event.type, plan, status },
        });
        break;
      }

      case "customer.subscription.deleted": {
        const s = event.data.object;
        const workspaceId = s.metadata?.workspace_id;
        if (!workspaceId) break;
        const subs = await sr.entities.WorkspaceSubscription.filter({ workspace_id: workspaceId });
        if (!subs[0]) break;
        // Downgrade, never delete: data stays; creation pauses via entitlements.
        await sr.entities.WorkspaceSubscription.update(subs[0].id, {
          plan: "free", status: "canceled", seats_extra: 0, cancel_at_period_end: false,
        });
        await logActivity(sr, {
          workspace_id: workspaceId, action: "subscription.changed",
          metadata: { via: "stripe_webhook", event: event.type, plan: "free" },
        });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        if (!customerId) break;
        const subs = await sr.entities.WorkspaceSubscription.filter({ stripe_customer_id: customerId });
        if (!subs[0]) break;
        await sr.entities.WorkspaceSubscription.update(subs[0].id, { status: "past_due" });
        const workspace = await sr.entities.Workspace.get(subs[0].workspace_id).catch(() => null);
        if (workspace?.owner_user_id) {
          await sr.entities.Notification.create({
            user_id: workspace.owner_user_id,
            workspace_id: subs[0].workspace_id,
            kind: "payment_failed",
            title: "Payment didn't go through",
            body: "We couldn't charge your card. Your data is safe — update your payment method to keep premium features.",
          }).catch(() => {});
        }
        break;
      }

      default:
        break;
    }
    return Response.json({ received: true });
  } catch (err) {
    console.error("[stripe webhook] handler error:", safeError(err));
    return Response.json({ error: "handler_failed" }, { status: 500 });
  }
});
