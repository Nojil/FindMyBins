// Store via SDK, claim via RAW fetch (like the app now does), with a
// deliberately STALE Authorization header to prove it's ignored.
import { createClient } from '@base44/sdk';
const APP='6a5fd45e9129f5171ccbb963', SERVER='https://base44.app';
const storer = createClient({ appId: APP });
const store = async (p) => (await storer.functions.invoke('api/auth-handoff', { action:'store', payload:p }))?.data;
const id = Array.from({length:32}, () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random()*62)]).join('');
const token = 'eyJhbGciOiJIUzI1NiJ9.' + 'y'.repeat(150) + '.sig';
await store({ handoff_id: id, access_token: token });

// Raw claim WITH a junk Bearer token — must still succeed (endpoint is unauthenticated).
let claimed = null;
for (let i=0;i<10;i++){
  const res = await fetch(`${SERVER}/api/apps/${APP}/functions/api/auth-handoff`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-App-Id':APP, 'Authorization':'Bearer stale.invalid.token' },
    body: JSON.stringify({ action:'claim', payload:{ handoff_id:id } }),
  });
  const body = await res.json();
  const data = body?.data ?? {};
  if (!res.ok) { console.log(`FAIL http ${res.status}`); process.exit(0); }
  if (data.status === 'ready') { claimed = data.access_token; break; }
  await new Promise(r=>setTimeout(r,600));
}
console.log(claimed === token ? 'PASS raw-fetch claim works even with a stale Authorization header' : 'FAIL not claimed');
process.exit(0);
