import { createClient } from '@base44/sdk';
// Two SEPARATE clients, like the browser relay vs the phone app.
const storer  = createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const claimer = createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const call = (cli) => async (action, payload) => {
  const r = await cli.functions.invoke('api/auth-handoff', { action, payload });
  return r?.data?.data ?? r?.data;
};
const store = call(storer), claim = call(claimer);
const id = Array.from({length:32}, () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random()*62)]).join('');
const token = 'eyJhbGciOiJIUzI1NiJ9.' + 'x'.repeat(200) + '.sig';

const t0 = Date.now();
await store('store', { handoff_id: id, access_token: token });
console.log(`stored at +0ms`);

// Poll from the OTHER client every 500ms; report when it first becomes claimable.
for (let i = 0; i < 40; i++) {
  const r = await claim('claim', { handoff_id: id });
  const dt = Date.now() - t0;
  if (r.status === 'ready') { console.log(`CLAIMED after ${dt}ms — token match: ${r.access_token === token}`); process.exit(0); }
  if (i % 4 === 0) console.log(`  +${dt}ms: ${r.status}`);
  await new Promise(r => setTimeout(r, 500));
}
console.log('NEVER became claimable within 20s — cross-client visibility problem confirmed');
process.exit(0);
