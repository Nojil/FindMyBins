import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
const base44 = createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const state = JSON.parse(readFileSync('phase12-state.json', 'utf8'));
const invoke = async (fn, action, payload) => {
  try { const r = await base44.functions.invoke(fn, { action, payload }); return r?.data?.data ?? r?.data; }
  catch (e) {
    const err = new Error(`${action} -> ${e?.response?.status}`);
    err.status = e?.response?.status; err.code = e?.response?.data?.error; err.body = e?.response?.data;
    throw err;
  }
};
const out = [];
const check = (name, cond, detail='') => out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

await base44.auth.verifyOtp({ email: 'six47webservices+fmbtest2@gmail.com', otpCode: '318021' });
await base44.auth.loginViaEmailPassword('six47webservices+fmbtest2@gmail.com', password);

// Before joining: workspace must be entirely invisible
const preErr = await invoke('api/workspaces', 'get_workspace', { workspace_id: state.wsId }).then(() => null, e => e);
check('non-member gets generic 404 (no metadata)', preErr?.status === 404 && preErr?.body?.error === 'not_found');

// Accept invite (Office-only viewer). Must confirm 13+.
const noAge = await invoke('api/members', 'accept_invitation', { token: state.inviteToken }).then(() => null, e => e);
check('accept without 13+ confirmation rejected', noAge?.status === 400);
const joined = await invoke('api/members', 'accept_invitation', { token: state.inviteToken, confirm_13_or_over: true });
check('invitation accepted', joined.status === 'joined' && joined.workspace?.id === state.wsId);
const reuse = await invoke('api/members', 'accept_invitation', { token: state.inviteToken, confirm_13_or_over: true }).then(() => null, e => e);
check('single-use token cannot be reused', reuse !== null, `status=${reuse?.status} code=${reuse?.code}`);

// Location isolation: only Office visible
const locs = (await invoke('api/locations', 'list_locations', { workspace_id: state.wsId })).locations;
check('sees ONLY the granted location', locs.length === 1 && locs[0].id === state.officeId,
  locs.map(l => l.name).join(','));

// Container isolation: Warehouse containers completely absent
const containers = (await invoke('api/containers', 'list_containers', { workspace_id: state.wsId })).containers;
check('no unauthorized containers in list (count isolation)', containers.every(c => c.location_id === state.officeId), `count=${containers.length}`);
const denied = await invoke('api/containers', 'get_container', { workspace_id: state.wsId, container_id: state.whContainerId }).then(() => null, e => e);
check('direct fetch of unauthorized container → generic 404', denied?.status === 404 && denied?.body?.error === 'not_found');
const deniedLookup = await invoke('api/containers', 'lookup_by_number', { workspace_id: state.wsId, number: 2 }).then(() => null, e => e);
check('number lookup of unauthorized container → generic 404', deniedLookup?.status === 404);

// Viewer cannot write anywhere, even in the granted location
const w1 = await invoke('api/containers', 'create_container', { workspace_id: state.wsId, location_id: state.officeId, title: 'Nope', container_type: 'bin' }).then(() => null, e => e);
check('viewer cannot create containers (403)', w1?.status === 403);
const w2 = await invoke('api/locations', 'create_location', { workspace_id: state.wsId, name: 'Nope' }).then(() => null, e => e);
check('viewer cannot create root locations (403)', w2?.status === 403);
const w3 = await invoke('api/members', 'create_invitation', { workspace_id: state.wsId, kind: 'link', invite_role: 'viewer' }).then(() => null, e => e);
check('viewer cannot invite members (403)', w3?.status === 403);

// Workspace view works but exposes no billing
const ws = (await invoke('api/workspaces', 'get_workspace', { workspace_id: state.wsId })).workspace;
check('viewer sees workspace without subscription details', ws.my_role === 'viewer' && ws.subscription === undefined);

console.log(out.join('\n'));
process.exit(0);
