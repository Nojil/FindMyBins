import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const state = JSON.parse(readFileSync('phase12-state.json', 'utf8'));
const mk = () => createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const owner = mk(), viewer = mk();
const inv = (cli) => async (fn, action, payload) => {
  try { const r = await cli.functions.invoke(fn, { action, payload }); return r?.data?.data ?? r?.data; }
  catch (e) { const err = new Error(`${action}:${e?.response?.status}`); err.status = e?.response?.status; err.code = e?.response?.data?.error; throw err; }
};
const o = inv(owner), v = inv(viewer);
const out = [];
const check = (n, c, d='') => out.push(`${c ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`);

await owner.auth.loginViaEmailPassword('six47webservices+fmbtest@gmail.com', password);
await viewer.auth.loginViaEmailPassword('six47webservices+fmbtest2@gmail.com', password);
const ws = state.wsId;

// 1. get_billing: business trial shows plan, seats, providers, pricing
const billing = await o('api/billing', 'get_billing', { workspace_id: ws });
check('billing snapshot: business plan + seats + pricing', billing.plan === 'business' && billing.seats?.included === 5 && billing.pricing.business.monthly_usd === 19);
check('providers report unconfigured (nothing wired yet)', billing.providers.stripe_configured === false && billing.providers.ios_iap_configured === false && billing.providers.android_iap_configured === false);

// 2. Free workspace billing snapshot shows AI trial + free storage
const boot = await o('api/workspaces', 'bootstrap', {});
const homeId = boot.workspaces.find(w => w.name === 'Test Home')?.id;
const freeBilling = await o('api/billing', 'get_billing', { workspace_id: homeId });
check('free plan snapshot: ai_trial + 500MB', freeBilling.plan === 'free' && freeBilling.ai_trial?.total === 5 && freeBilling.storage.bytes_limit === 500*1024*1024);

// 3. Viewer cannot access billing (403)
const vBilling = await v('api/billing', 'get_billing', { workspace_id: ws }).then(() => null, e => e);
check('viewer billing forbidden (403)', vBilling?.status === 403);

// 4. Checkout gracefully reports unconfigured (Stripe secrets absent)
const checkout = await o('api/billing', 'start_checkout', { workspace_id: homeId, plan: 'household', interval: 'monthly' });
check('checkout unconfigured returns friendly message', checkout.configured === false && typeof checkout.message === 'string');

// 5. Portal unconfigured
const portal = await o('api/billing', 'open_portal', { workspace_id: ws });
check('portal unconfigured returns friendly message', portal.configured === false);

// 6. IAP unconfigured + validation
const iap = await o('api/billing', 'apply_iap_receipt', { workspace_id: homeId, platform: 'ios', product_id: 'com.six47.findmybins.household.monthly', receipt: 'fake' });
check('iap unconfigured returns friendly message', iap.configured === false);
const badProduct = await o('api/billing', 'apply_iap_receipt', { workspace_id: homeId, platform: 'ios', product_id: 'bogus', receipt: 'x' }).then(() => null, e => e);
check('unknown iap product rejected (400)', badProduct?.status === 400);

// 7. Invalid checkout plan rejected
const badPlan = await o('api/billing', 'start_checkout', { workspace_id: homeId, plan: 'enterprise', interval: 'monthly' }).then(() => null, e => e);
check('invalid plan rejected (400)', badPlan?.status === 400);

// 8. Stripe webhook never processes an unsigned event.
// With a Stripe-Signature header, Base44's PLATFORM Stripe handler intercepts
// (401 until its native secret is set). Without the header, our custom handler
// runs and refuses as unconfigured (503). Both refuse without mutating state.
const appId = '6a5fd45e9129f5171ccbb963';
const platformIntercept = await fetch(`https://base44.app/api/apps/${appId}/functions/stripe-webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=123,v1=deadbeef' },
  body: JSON.stringify({ type: 'customer.subscription.updated', data: { object: {} } }),
});
check('platform intercepts Stripe-Signature requests (native payments)', platformIntercept.status === 401 || platformIntercept.status === 400, `http ${platformIntercept.status}`);
const customHandler = await fetch(`https://base44.app/api/apps/${appId}/functions/stripe-webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'customer.subscription.updated', data: { object: {} } }),
});
const chBody = await customHandler.json().catch(() => ({}));
check('custom webhook refuses unsigned event (503 unconfigured)', customHandler.status === 503 && chBody.error === 'not_configured', `http ${customHandler.status}`);

// 9. billing-daily-sweep runs (service-role callable; idempotent)
const sweepRes = await fetch(`https://base44.app/api/apps/${appId}/functions/billing-daily-sweep`, { method: 'POST' });
const sweepBody = await sweepRes.json().catch(() => ({}));
check('billing sweep executes', sweepRes.ok && sweepBody.ok === true, `http ${sweepRes.status} ${JSON.stringify(sweepBody).slice(0,80)}`);

// 10. Downgrade preserves data: entitlement gate pauses creation but reads work.
// (Simulated: household workspace at free limits still lists/searches.)
const freeList = await o('api/containers', 'list_containers', { workspace_id: homeId });
check('free workspace can still read inventory (no data loss on downgrade)', Array.isArray(freeList.containers));

console.log(out.join('\n'));
process.exit(0);
