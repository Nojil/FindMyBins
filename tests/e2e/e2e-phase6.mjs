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

// Fresh container for the vision test
const cont = (await o('api/containers', 'create_container', { workspace_id: ws, location_id: state.whId, title: 'AI Test Box', container_type: 'box' })).container;

// 1. Generate a synthetic contents photo, upload as private media
const gen = await owner.integrations.Core.GenerateImage({
  prompt: 'Top-down photo of an open cardboard storage box containing exactly three objects: a red coffee mug, a yellow flashlight, and a coiled blue rope. Bright even lighting, all objects fully visible.',
});
const genUrl = gen?.data?.url ?? gen?.url;
check('image generated', typeof genUrl === 'string', String(genUrl).slice(0, 60));
const imgBytes = Buffer.from(await (await fetch(genUrl)).arrayBuffer());
const file = new File([imgBytes], 'contents.png', { type: 'image/png' });
const up = await owner.integrations.Core.UploadPrivateFile({ file });
const fileUri = up?.data?.file_uri ?? up?.file_uri;
const media = (await o('api/files', 'register_media', { workspace_id: ws, owner_type: 'container', owner_id: cont.id, file_uris: { full: fileUri }, bytes_total: imgBytes.length, content_type: 'image/png' })).media;

// 2. Analyze → drafts
const analysis = await o('api/capture', 'analyze_photos', { workspace_id: ws, container_id: cont.id, media_ids: [media.id] });
check('analysis ready with drafts', analysis.status === 'ready' && analysis.drafts.length >= 2, `${analysis.drafts.length} drafts`);
check('all results are drafts with confidence', analysis.drafts.every(d => d.state === 'draft' && ['high','medium','low'].includes(d.ai_confidence)));
const names = analysis.drafts.map(d => d.name.toLowerCase()).join(', ');
check('recognized expected objects', /mug|cup/.test(names) && /flashlight|torch/.test(names) && /rope|cord/.test(names), names);

// 3. Drafts are invisible to normal item lists until confirmed
const listed = (await o('api/items', 'list_items', { workspace_id: ws, container_id: cont.id })).items;
check('drafts excluded from confirmed item list', listed.length === 0, `${listed.length}`);

// 4. Confirm one with an edit, discard the rest
const [first, ...rest] = analysis.drafts;
const conf = await o('api/capture', 'confirm_drafts', { workspace_id: ws, items: [{ item_id: first.id, patch: { quantity: 1 } }] });
check('draft confirmed with edit', conf.confirmed.length === 1 && conf.confirmed[0].state === 'confirmed' && conf.confirmed[0].quantity === 1);
const disc = await o('api/capture', 'discard_drafts', { workspace_id: ws, item_ids: rest.map(r => r.id) });
check('remaining drafts discarded', disc.discarded === rest.length);
const after = (await o('api/items', 'list_items', { workspace_id: ws, container_id: cont.id })).items;
check('exactly the confirmed item remains', after.length === 1 && after[0].id === first.id);

// 5. NL search cites real, authorized records
const nl = await o('api/search', 'natural', { workspace_id: ws, query: 'Where are my fall pillows and how many do I have?' });
check('NL answer with citations', nl.answer.length > 10 && nl.matches.length >= 1 && nl.matches.every(m => m.location_path));
check('NL citations include pillows records', nl.matches.some(m => m.item?.name === 'Fall pillows'), nl.matches.map(m => m.item?.name ?? m.container?.title).join(','));

// 6. Viewer NL search cannot surface Warehouse data
const vnl = await v('api/search', 'natural', { workspace_id: ws, query: 'Where are the fall pillows?' });
check('viewer NL: no hidden records leak', vnl.matches.length === 0 && vnl.no_reliable_result === true, vnl.answer.slice(0, 80));

// 7. Free household workspace: NL gated, AI trial metered
const boot = await o('api/workspaces', 'bootstrap', {});
const homeId = boot.workspaces.find(w => w.name === 'Test Home')?.id;
const gate = await o('api/search', 'natural', { workspace_id: homeId, query: 'where are my albums' }).then(() => null, e => e);
check('free plan NL search gated (402 plan_limit)', gate?.status === 402 && gate?.code === 'plan_limit');
const hhBarcode = await o('api/capture', 'barcode_lookup', { workspace_id: homeId, barcode: '036000291452' }).then(() => null, e => e);
check('household barcode rejected', hhBarcode?.status === 400);

// 8. Business barcode suggestion + approved add
const bc = await o('api/capture', 'barcode_lookup', { workspace_id: ws, barcode: '012000161155' });
check('barcode suggestion returned', bc.suggestion === null || typeof bc.suggestion.name === 'string', JSON.stringify(bc.suggestion)?.slice(0, 100));
const added = await o('api/capture', 'barcode_add', { workspace_id: ws, container_id: cont.id, barcode: bc.barcode, fields: { name: bc.suggestion?.name || 'Unknown product', brand: bc.suggestion?.brand } });
check('barcode item added on approval', added.item.origin === 'barcode' && added.item.state === 'confirmed');

console.log(out.join('\n'));
process.exit(0);
