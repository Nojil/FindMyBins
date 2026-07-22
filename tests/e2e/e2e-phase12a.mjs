import { createClient } from '@base44/sdk';
import { readFileSync, writeFileSync } from 'fs';
const base44 = createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const invoke = async (fn, action, payload) => {
  try {
    const r = await base44.functions.invoke(fn, { action, payload });
    return r?.data?.data ?? r?.data;
  } catch (e) {
    const body = e?.response?.data;
    const err = new Error(`${action} -> ${e?.response?.status} ${JSON.stringify(body)}`);
    err.status = e?.response?.status; err.code = body?.error;
    throw err;
  }
};
const results = [];
const check = (name, cond, detail='') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

await base44.auth.loginViaEmailPassword('six47webservices+fmbtest@gmail.com', password);

// Reuse or create the Test Biz workspace, ensure business trial
const boot = await invoke('api/workspaces', 'bootstrap', {});
let wsId = boot.workspaces.find(w => w.name === 'Test Biz')?.id;
if (!wsId) wsId = (await invoke('api/workspaces', 'create_workspace', { name: 'Test Biz', workspace_type: 'business' })).workspace.id;
const ws = (await invoke('api/workspaces', 'get_workspace', { workspace_id: wsId })).workspace;
if (ws.plan === 'free') {
  const t = await invoke('api/workspaces', 'start_trial', { workspace_id: wsId });
  check('business trial started', t.status === 'trialing' && t.plan === 'business');
} else check('business trial active', ws.plan === 'business', ws.plan);

// Locations (idempotent by name)
const locList = async () => (await invoke('api/locations', 'list_locations', { workspace_id: wsId })).locations;
let locs = await locList();
const ensure = async (name, parent_id) => {
  const found = locs.find(l => l.name === name && (l.parent_id ?? null) === (parent_id ?? null));
  if (found) return found;
  return (await invoke('api/locations', 'create_location', { workspace_id: wsId, name, parent_id })).location;
};
const wh = await ensure('Warehouse') ?? await ensure('Main Warehouse');
const eq = await ensure('Equipment Room', wh.id);
const office = await ensure('Office');
check('child path text', eq.path_text.endsWith('› Equipment Room') && eq.level === 1, eq.path_text);

// Rename cascades
await invoke('api/locations', 'rename_location', { workspace_id: wsId, location_id: wh.id, name: 'Main Warehouse' });
locs = await locList();
check('rename cascades to child path', locs.find(l => l.id === eq.id).path_text === 'Main Warehouse › Equipment Room', locs.find(l => l.id === eq.id).path_text);

// CONCURRENCY: 8 parallel container creates
const creations = await Promise.all(Array.from({ length: 8 }, (_, i) =>
  invoke('api/containers', 'create_container', { workspace_id: wsId, location_id: wh.id, title: `Bin ${i}`, container_type: 'bin' })
    .then(r => r.container, e => ({ error: String(e) }))
));
const okCreations = creations.filter(c => !c.error);
const numbers = okCreations.map(c => c.number).sort((a, b) => a - b);
check('8 concurrent creates succeeded', okCreations.length === 8, creations.filter(c=>c.error).map(c=>c.error).join(' | '));
check('numbers all unique', new Set(numbers).size === numbers.length, numbers.join(','));
check('numbers contiguous from 1', numbers.length && numbers[0] === 1 && numbers[numbers.length-1] === numbers.length, numbers.join(','));
check('qr tokens unique', new Set(okCreations.map(c => c.qr_link)).size === okCreations.length);

// Archive semantics
const victim = okCreations[0];
await invoke('api/containers', 'set_archived', { workspace_id: wsId, container_id: victim.id, archived: true });
const active = (await invoke('api/containers', 'list_containers', { workspace_id: wsId })).containers;
const archived = (await invoke('api/containers', 'list_containers', { workspace_id: wsId, archived_filter: true })).containers;
check('archived hidden by default, visible via filter', !active.some(c => c.id === victim.id) && archived.some(c => c.id === victim.id));
const next = (await invoke('api/containers', 'create_container', { workspace_id: wsId, location_id: office.id, title: 'Office Box', container_type: 'box' })).container;
check('archived number stays reserved', next.number === numbers.length + 1, `next=${next.number}`);
const renumErr = await invoke('api/containers', 'renumber_container', { workspace_id: wsId, container_id: next.id, new_number: victim.number }).then(() => null, e => e.code);
check('renumber into retired number rejected', renumErr === 'number_taken', String(renumErr));

// Move keeps number + QR
await invoke('api/containers', 'move_container', { workspace_id: wsId, container_id: next.id, new_location_id: eq.id });
const moved = (await invoke('api/containers', 'get_container', { workspace_id: wsId, container_id: next.id })).container;
check('move keeps number/QR, changes location', moved.location_id === eq.id && moved.number === next.number && moved.qr_link === next.qr_link);

// Location-scoped viewer invite (Office only)
const invite = await invoke('api/members', 'create_invitation', { workspace_id: wsId, kind: 'link', invite_role: 'viewer', location_ids: [office.id] });
check('invitation link issued', typeof invite.link === 'string' && invite.link.includes('/join/'));

writeFileSync('phase12-state.json', JSON.stringify({
  wsId, officeId: office.id, whId: wh.id,
  whContainerId: okCreations[1]?.id, officeContainerId: next.id, movedOffice: true,
  inviteToken: invite.link.split('/join/')[1],
}, null, 2));
console.log(results.join('\n'));
process.exit(0);
