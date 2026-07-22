import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const state = JSON.parse(readFileSync('phase12-state.json', 'utf8'));
const mk = () => createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const owner = mk(), viewer = mk(), anon = mk();
const inv = (cli) => async (fn, action, payload) => {
  try { const r = await cli.functions.invoke(fn, { action, payload }); return r?.data?.data ?? r?.data; }
  catch (e) { const err = new Error(`${action}:${e?.response?.status}`); err.status = e?.response?.status; err.body = e?.response?.data; throw err; }
};
const o = inv(owner), v = inv(viewer), a = inv(anon);
const out = [];
const check = (n, c, d='') => out.push(`${c ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`);
const token = (c) => c.qr_link.split('/q/')[1];

await owner.auth.loginViaEmailPassword('six47webservices+fmbtest@gmail.com', password);
await viewer.auth.loginViaEmailPassword('six47webservices+fmbtest2@gmail.com', password);
const ws = state.wsId;

const active = (await o('api/containers', 'list_containers', { workspace_id: ws })).containers;
const archived = (await o('api/containers', 'list_containers', { workspace_id: ws, archived_filter: true })).containers;
const whC = active.find(c => c.location_id === state.whId);
const officeC = active.find(c => c.location_id === state.officeId);
const archC = archived[0];

// 1. Owner scan → full active payload
const scan = await o('api/qr', 'resolve', { qr_token: token(whC) });
check('owner scan resolves with items + location path', scan.state === 'active' && scan.container.id === whC.id && Array.isArray(scan.items) && typeof scan.container.location_path === 'string', `${scan.items?.length} items`);

// 2. Viewer scan of granted-location container → allowed
const vScan = await v('api/qr', 'resolve', { qr_token: token(officeC) });
check('viewer scan of granted container allowed', vScan.state === 'active' && vScan.my_role === 'viewer');

// 3. Viewer scan of ungranted container → generic 404
const vDenied = await v('api/qr', 'resolve', { qr_token: token(whC) }).then(() => null, e => e);
// 4. Unknown token → generic 404 with IDENTICAL body
const unknown = await v('api/qr', 'resolve', { qr_token: 'zzzzzzzzzzzzzzzzzzzzzz' }).then(() => null, e => e);
check('unauthorized scan → 404', vDenied?.status === 404);
check('unknown token → 404', unknown?.status === 404);
check('denial bodies identical (no enumeration signal)', JSON.stringify(vDenied?.body) === JSON.stringify(unknown?.body), JSON.stringify(unknown?.body));

// 5. Unauthenticated scan → bare 401
const anonRes = await a('api/qr', 'resolve', { qr_token: token(whC) }).then(() => null, e => e);
check('unauthenticated scan → 401 with no metadata', anonRes?.status === 401 && JSON.stringify(anonRes?.body).indexOf(whC.title) === -1);

// 6. Archived container scan → archived state + restore flag
const archScan = await o('api/qr', 'resolve', { qr_token: token(archC) });
check('archived scan shows archived state + can_restore', archScan.state === 'archived' && archScan.can_restore === true);

// 7. Labels: render letter sheet for 3 containers, mark printed
const three = active.filter(c => c.location_id === state.whId).slice(0, 3).map(c => c.id);
const pdf = await o('api/labels', 'render_labels', { workspace_id: ws, container_ids: three, format: 'letter_sheet', mark_printed: true });
check('label PDF rendered (1 page, 3 labels)', typeof pdf.pdf_url === 'string' && pdf.label_count === 3 && pdf.pages === 1);
const resp = await fetch(pdf.pdf_url);
const buf = Buffer.from(await resp.arrayBuffer());
check('PDF bytes valid', resp.ok && buf.subarray(0, 4).toString() === '%PDF' && buf.length > 2000, `${buf.length}b`);

// 8. Print queue excludes printed
const queue = (await o('api/labels', 'print_queue', { workspace_id: ws })).queue;
check('printed containers left the queue', three.every(id => !queue.some(q => q.id === id)), `queue=${queue.length}`);

// 9. Alignment test page (thermal)
const test = await o('api/labels', 'render_test_page', { workspace_id: ws, format: 'thermal_4x6' });
const tResp = await fetch(test.pdf_url);
check('alignment test page renders', tResp.ok && Buffer.from(await tResp.arrayBuffer()).subarray(0, 4).toString() === '%PDF');

// 10. Custom format that doesn't fit → 400
const badFmt = await o('api/labels', 'render_labels', { workspace_id: ws, container_ids: three, format: 'custom', custom: { page_w_in: 4, page_h_in: 2, label_w_in: 3, label_h_in: 2, cols: 2, rows: 1 } }).then(() => null, e => e);
check('impossible custom format rejected (400)', badFmt?.status === 400);

// 11. Viewer cannot print labels
const vPrint = await v('api/labels', 'render_labels', { workspace_id: ws, container_ids: [officeC.id], format: 'label_3x2' }).then(() => null, e => e);
check('viewer cannot render labels (403)', vPrint?.status === 403);

// 12. Label prefs roundtrip
await o('api/labels', 'set_prefs', { workspace_id: ws, label_prefs: { format: 'letter_sheet', show_location: true } });
const prefs = (await o('api/labels', 'get_prefs', { workspace_id: ws })).label_prefs;
check('label prefs persisted', prefs?.format === 'letter_sheet');

console.log(out.join('\n'));
process.exit(0);
