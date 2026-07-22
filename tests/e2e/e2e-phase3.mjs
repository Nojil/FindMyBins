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

// Containers to work with
const cs = (await o('api/containers', 'list_containers', { workspace_id: ws })).containers;
const whA = cs.find(c => c.id === state.whContainerId) ?? cs.find(c => c.location_id === state.whId);
const whB = cs.find(c => c.location_id === state.whId && c.id !== whA.id);
const officeBox = (await o('api/containers', 'create_container', { workspace_id: ws, location_id: state.officeId, title: 'Office Shelf Box', container_type: 'box' })).container;

// 1. Manual entry, name-only → quantity null
const pillows = (await o('api/items', 'create_item', { workspace_id: ws, container_id: whA.id, name: 'Fall pillows' })).item;
check('manual item, quantity unspecified (null, not 1)', pillows.quantity === null && pillows.origin === 'manual');

// 2. Quick list → individual records
const ql = (await o('api/items', 'quick_add', { workspace_id: ws, container_id: whA.id, lines: 'HDMI cables\nPower strips\n\nExtension cords\nLabel maker' })).items;
check('quick list → 4 individual items', ql.length === 4 && ql.every(i => i.origin === 'quicklist' && i.quantity === null), `${ql.length}`);

// 3. Business fields allowed in business workspace
const branded = (await o('api/items', 'update_item', { workspace_id: ws, item_id: pillows.id, patch: { brand: 'HomeCo', quantity: 10, category: 'Decor' } })).item;
check('business fields + quantity update', branded.brand === 'HomeCo' && branded.quantity === 10);

// 4. Household field policy blocks business-only fields
const boot = await o('api/workspaces', 'bootstrap', {});
const homeId = boot.workspaces.find(w => w.name === 'Test Home')?.id;
let homeLoc = (await o('api/locations', 'list_locations', { workspace_id: homeId })).locations[0];
if (!homeLoc) homeLoc = (await o('api/locations', 'create_location', { workspace_id: homeId, name: 'Home' })).location;
const homeBin = (await o('api/containers', 'create_container', { workspace_id: homeId, location_id: homeLoc.id, title: 'Keepsakes', container_type: 'bin' })).container;
const homeItem = (await o('api/items', 'create_item', { workspace_id: homeId, container_id: homeBin.id, name: 'Photo albums', condition: 'good' })).item;
check('household More Details field accepted', homeItem.condition === 'good');
const hhErr = await o('api/items', 'update_item', { workspace_id: homeId, item_id: homeItem.id, patch: { brand: 'X' } }).then(() => null, e => e);
check('household rejects business-only field (400)', hhErr?.status === 400);

// 5. Bulk move
await o('api/items', 'move_items', { workspace_id: ws, item_ids: [ql[0].id, ql[1].id], dest_container_id: whB.id });
const inB = (await o('api/items', 'list_items', { workspace_id: ws, container_id: whB.id })).items;
check('bulk move landed in destination', [ql[0].id, ql[1].id].every(id => inB.some(i => i.id === id)));

// 6. Split partial quantity (10 → 6 + 4)
const split = await o('api/items', 'split_item', { workspace_id: ws, item_id: pillows.id, dest_container_id: whB.id, quantity_to_move: 4 });
check('split: source 6, dest 4', split.source?.quantity === 6 && split.dest_item?.quantity === 4);
const noQty = await o('api/items', 'split_item', { workspace_id: ws, item_id: ql[2].id, dest_container_id: whB.id, quantity_to_move: 1 }).then(() => null, e => e);
check('split without quantity rejected (never assume 1)', noQty?.status === 400);

// 7. Merge duplicates (2 + 3 → 5, loser soft-deleted)
const d1 = (await o('api/items', 'create_item', { workspace_id: ws, container_id: whA.id, name: 'Tablecloths', quantity: 2 })).item;
const d2 = (await o('api/items', 'create_item', { workspace_id: ws, container_id: whA.id, name: 'Tablecloths', quantity: 3, tags: ['linen'] })).item;
const merged = (await o('api/items', 'merge_items', { workspace_id: ws, keep_item_id: d1.id, item_ids: [d2.id] })).item;
const afterMerge = (await o('api/items', 'list_items', { workspace_id: ws, container_id: whA.id })).items;
check('merge sums quantities + union tags, removes loser', merged.quantity === 5 && merged.tags.includes('linen') && !afterMerge.some(i => i.id === d2.id));

// 8. Delete → recovery → restore
await o('api/items', 'delete_item', { workspace_id: ws, item_id: ql[3].id });
const listed = (await o('api/items', 'list_items', { workspace_id: ws, container_id: whA.id })).items;
const deleted = (await o('api/items', 'list_deleted', { workspace_id: ws })).items;
check('deleted item hidden from lists, visible in recovery', !listed.some(i => i.id === ql[3].id) && deleted.some(i => i.id === ql[3].id));
const restored = (await o('api/items', 'restore_deleted', { workspace_id: ws, item_id: ql[3].id })).item;
check('restore from recovery works', restored.deleted_at === null);

// 9. Media: real private upload → register → signed URL → delete
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const file = new File([png], 'photo.png', { type: 'image/png' });
const up = await owner.integrations.Core.UploadPrivateFile({ file });
const fileUri = up?.data?.file_uri ?? up?.file_uri;
check('private upload returned uri', typeof fileUri === 'string' && fileUri.length > 0, String(fileUri).slice(0, 40));
const media = (await o('api/files', 'register_media', { workspace_id: ws, owner_type: 'container', owner_id: whA.id, file_uris: { full: fileUri }, bytes_total: png.length, content_type: 'image/png' })).media;
const urls = (await o('api/files', 'get_media_urls', { workspace_id: ws, media_ids: [media.id], variant: 'full' })).urls;
check('signed URL issued', typeof urls[media.id] === 'string');
const resp = await fetch(urls[media.id]);
check('signed URL serves bytes', resp.ok, `http ${resp.status}`);
const wsInfo = (await o('api/workspaces', 'get_workspace', { workspace_id: ws })).workspace;
check('storage accounted', (wsInfo.subscription?.storage_bytes_used ?? 0) >= png.length, `${wsInfo.subscription?.storage_bytes_used}b`);
await o('api/files', 'delete_media', { workspace_id: ws, media_id: media.id });
const urls2 = (await o('api/files', 'get_media_urls', { workspace_id: ws, media_ids: [media.id], variant: 'full' })).urls;
check('deleted media no longer served', urls2[media.id] === undefined);

// 10. Viewer isolation on items + media
const officeItem = (await o('api/items', 'create_item', { workspace_id: ws, container_id: officeBox.id, name: 'Staplers', quantity: 3 })).item;
const vItems = (await v('api/items', 'list_items', { workspace_id: ws })).items;
check('viewer sees only Office items', vItems.length >= 1 && vItems.every(i => i.location_id === state.officeId), `count=${vItems.length}`);
const vDenied = await v('api/items', 'get_item', { workspace_id: ws, item_id: pillows.id }).then(() => null, e => e);
check('viewer direct item fetch → generic 404', vDenied?.status === 404);
const vWrite = await v('api/files', 'register_media', { workspace_id: ws, owner_type: 'container', owner_id: officeBox.id, file_uris: { full: 'x' }, bytes_total: 10, content_type: 'image/png' }).then(() => null, e => e);
check('viewer cannot register media (403)', vWrite?.status === 403);

console.log(out.join('\n'));
process.exit(0);
