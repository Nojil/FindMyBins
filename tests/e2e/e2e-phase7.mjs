import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
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

// 1. Full pull: policy + scoped data + cursors
const pull1 = await o('api/sync', 'pull', { workspace_id: ws, cursors: {} });
check('pull returns policy (business 7d default)', pull1.policy.revalidate_days === 7 && pull1.policy.mode === '7_days');
check('pull returns records + cursors', pull1.changes.containers.records.length > 10 && typeof pull1.changes.containers.cursor === 'string');
check('owner accessible=null (all)', pull1.accessible_location_ids === null);

// 2. Viewer pull: scope isolation
const vpull = await v('api/sync', 'pull', { workspace_id: ws, cursors: {} });
check('viewer pull only Office data', vpull.accessible_location_ids?.length === 1 &&
  vpull.changes.containers.records.every(c => c.location_id === state.officeId) &&
  vpull.changes.locations.records.every(l => l.id === state.officeId),
  `containers=${vpull.changes.containers.records.length}`);

// 3. Offline create with idempotent replay → ONE container, ONE number
const uuid = randomUUID();
const mut = { client_mutation_id: randomUUID(), kind: 'create_container',
  payload: { client_uuid: uuid, location_id: state.whId, title: 'Offline Crate', container_type: 'crate' } };
const push1 = await o('api/sync', 'push', { workspace_id: ws, mutations: [mut] });
const rec1 = push1.results[0];
check('offline create applied with server number + QR', rec1.status === 'applied' && rec1.record.number > 0 && !rec1.record.pending_number && rec1.record.qr_token?.length === 22);
const push2 = await o('api/sync', 'push', { workspace_id: ws, mutations: [mut] });
const rec2 = push2.results[0];
check('replayed create is idempotent (same record)', rec2.status === 'applied' && rec2.record.id === rec1.record.id && rec2.record.number === rec1.record.number);

// 4. Offline item referencing container by client_uuid
const itemUuid = randomUUID();
const push3 = await o('api/sync', 'push', { workspace_id: ws, mutations: [
  { client_mutation_id: randomUUID(), kind: 'create_item', payload: { client_uuid: itemUuid, container_client_uuid: uuid, name: 'Offline Widget', quantity: 5 } },
] });
check('offline item created via parent client_uuid', push3.results[0].status === 'applied' && push3.results[0].record.container_id === rec1.record.id);
const offlineItem = push3.results[0].record;

// 5. Quantity conflict: stale base + server-side change → review, both versions
await o('api/items', 'update_item', { workspace_id: ws, item_id: offlineItem.id, patch: { quantity: 9 } });
const conflictPush = await o('api/sync', 'push', { workspace_id: ws, mutations: [
  { client_mutation_id: randomUUID(), kind: 'update_item', payload: { item_id: offlineItem.id, base_updated_date: offlineItem.updated_date, patch: { quantity: 2 } } },
] });
const c1 = conflictPush.results[0];
check('quantity conflict → review with both versions', c1.status === 'conflict' && c1.reason === 'quantity' && c1.server_record.quantity === 9 && c1.client_payload.patch.quantity === 2);
const afterConflict = await o('api/items', 'get_item', { workspace_id: ws, item_id: offlineItem.id });
check('server version preserved on conflict', afterConflict.item.quantity === 9);

// 6. Harmless stale edit (name) → last-write-wins applied
const harmless = await o('api/sync', 'push', { workspace_id: ws, mutations: [
  { client_mutation_id: randomUUID(), kind: 'update_item', payload: { item_id: offlineItem.id, base_updated_date: offlineItem.updated_date, patch: { name: 'Offline Widget v2' } } },
] });
check('harmless stale edit applied', harmless.results[0].status === 'applied' && harmless.results[0].record.name === 'Offline Widget v2');

// 7. Archive-vs-edit conflict
await o('api/containers', 'set_archived', { workspace_id: ws, container_id: rec1.record.id, archived: true });
const archEdit = await o('api/sync', 'push', { workspace_id: ws, mutations: [
  { client_mutation_id: randomUUID(), kind: 'update_container', payload: { container_id: rec1.record.id, patch: { title: 'New title' } } },
] });
check('archive-vs-edit → conflict', archEdit.results[0].status === 'conflict' && archEdit.results[0].reason === 'archived_vs_edit');
await o('api/containers', 'set_archived', { workspace_id: ws, container_id: rec1.record.id, archived: false });

// 8. Incompatible move conflict
const moved = await o('api/sync', 'push', { workspace_id: ws, mutations: [
  { client_mutation_id: randomUUID(), kind: 'move_container', payload: { container_id: rec1.record.id, base_location_id: state.officeId, new_location_id: state.officeId } },
] });
check('incompatible move → conflict', moved.results[0].status === 'conflict' && moved.results[0].reason === 'incompatible_move');

// 9. Cursor delta: second pull returns only what changed since
const pull2 = await o('api/sync', 'pull', { workspace_id: ws, cursors: {
  containers: pull1.changes.containers.cursor, items: pull1.changes.items.cursor, locations: pull1.changes.locations.cursor,
} });
const deltaIds = pull2.changes.containers.records.map(c => c.id);
check('cursor pull is a delta', pull2.changes.containers.records.length < pull1.changes.containers.records.length && deltaIds.includes(rec1.record.id),
  `delta=${pull2.changes.containers.records.length} vs full=${pull1.changes.containers.records.length}`);

// 10. Viewer cannot push into Warehouse
const vpush = await v('api/sync', 'push', { workspace_id: ws, mutations: [
  { client_mutation_id: randomUUID(), kind: 'create_container', payload: { client_uuid: randomUUID(), location_id: state.whId, title: 'Nope' } },
] });
check('viewer offline create rejected per-mutation', vpush.results[0].status === 'rejected');

console.log(out.join('\n'));
process.exit(0);
