// Stripe integration via plain REST (no SDK). Everything is gated on the
// presence of secrets, so the code paths are complete but dormant until the
// Stripe account is wired up:
//   base44 secrets set STRIPE_SECRET_KEY sk_live_…
//   base44 secrets set STRIPE_WEBHOOK_SECRET whsec_…
//   base44 secrets set STRIPE_PRICE_HOUSEHOLD_MONTHLY price_… (etc, see PRICE_KEYS)

export const PRICE_KEYS = [
  "STRIPE_PRICE_HOUSEHOLD_MONTHLY",
  "STRIPE_PRICE_HOUSEHOLD_ANNUAL",
  "STRIPE_PRICE_BUSINESS_MONTHLY",
  "STRIPE_PRICE_BUSINESS_ANNUAL",
  "STRIPE_PRICE_SEAT_MONTHLY",
  "STRIPE_PRICE_SEAT_ANNUAL",
] as const;

export function stripeConfigured(): boolean {
  return !!Deno.env.get("STRIPE_SECRET_KEY");
}

export function priceIdFor(plan: "household" | "business", interval: "monthly" | "annual"): string | null {
  return Deno.env.get(`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`) ?? null;
}

export function seatPriceId(interval: "monthly" | "annual"): string | null {
  return Deno.env.get(`STRIPE_PRICE_SEAT_${interval.toUpperCase()}`) ?? null;
}

/** Reverse-map a Stripe price id to plan/interval/seat. */
export function planForPriceId(priceId: string): { plan?: "household" | "business"; interval?: "monthly" | "annual"; seat?: boolean } | null {
  for (const key of PRICE_KEYS) {
    if (Deno.env.get(key) !== priceId) continue;
    if (key.includes("SEAT")) return { seat: true, interval: key.endsWith("ANNUAL") ? "annual" : "monthly" };
    return {
      plan: key.includes("HOUSEHOLD") ? "household" : "business",
      interval: key.endsWith("ANNUAL") ? "annual" : "monthly",
    };
  }
  return null;
}

/** Form-encoded Stripe API request. */
export async function stripeRequest(
  path: string,
  params: Record<string, string>,
  method = "POST",
): Promise<Record<string, any>> {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("stripe_not_configured");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : new URLSearchParams(params).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`stripe_error: ${body?.error?.message ?? res.status}`);
  return body;
}

/** Verify a Stripe-Signature header (t=…,v1=…) against the raw body. */
export async function verifyStripeSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
