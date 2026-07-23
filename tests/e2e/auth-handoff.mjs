import { createClient } from '@base44/sdk';
const base44 = createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const call = async (action, payload) => {
  const r = await base44.functions.invoke('api/auth-handoff', { action, payload });
  return r?.data?.data ?? r?.data;
};
const out = [];
const check = (n, c, d='') => out.push(`${c ? 'PASS' : 'FAIL'} ${n}${d?' — '+d:''}`);
const id = Array.from({length:32}, () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random()*62)]).join('');
const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.' + 'x'.repeat(120) + '.sig';

// 1. Before store: claim is pending
let r = await call('claim', { handoff_id: id });
check('unstored id -> pending', r.status === 'pending', JSON.stringify(r));

// 2. Store (unauthenticated, as the browser page does)
r = await call('store', { handoff_id: id, access_token: fakeToken });
check('store succeeds', r.stored === true);

// 3. Claim returns the token exactly once
r = await call('claim', { handoff_id: id });
check('claim returns token', r.status === 'ready' && r.access_token === fakeToken);

// 4. Second claim is consumed
r = await call('claim', { handoff_id: id });
check('single-use: 2nd claim not ready', r.status !== 'ready', JSON.stringify(r));

// 5. Bad id shape rejected on claim
try { await call('claim', { handoff_id: 'short' }); check('claim bad id rejected', false); }
catch (e) { check('claim bad id rejected', e?.response?.status === 404); }

// 6. Bad id shape rejected on store
try { await call('store', { handoff_id: 'short', access_token: fakeToken }); check('store bad id rejected', false); }
catch (e) { check('store bad id rejected', e?.response?.status === 400); }

console.log(out.join('\n'));
process.exit(0);
