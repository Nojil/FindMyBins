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

// ===== CSV IMPORT =====
const csv = 'Title,Type,Category,Location\n"Import Bin A",bin,Seasonal,"Import Zone > Shelf 1"\n"Import Bin B, special",tote,Tools,"Import Zone > Shelf 1"\n"Import Bin C",box,,"Import Zone > Shelf 2"\n';

// 1. Analyze: mapping detection + validation
const analysis = await o('api/imports', 'import_analyze', { workspace_id: ws, kind: 'containers', csv_text: csv });
check('analyze detects mapping + rows', analysis.mapping.title === 0 && analysis.mapping.location_path === 3 && analysis.valid_rows === 3 && analysis.missing_required.length === 0);

// 2. Commit: creates containers + locations, numbers allocated
const commit = await o('api/imports', 'import_commit', { workspace_id: ws, kind: 'containers', csv_text: csv, duplicate_mode: 'skip' });
check('commit created 3 containers', commit.created === 3 && commit.errors.length === 0, JSON.stringify(commit));
const all = (await o('api/containers', 'list_containers', { workspace_id: ws })).containers;
const importedA = all.find(c => c.title === 'Import Bin A');
const importedComma = all.find(c => c.title === 'Import Bin B, special');
check('quoted comma title imported intact', !!importedComma);
check('imported containers have unique numbers + location path', importedA?.number_display && importedA?.location_path === 'Import Zone › Shelf 1');

// 3. Re-commit with skip → all duplicates skipped
const recommit = await o('api/imports', 'import_commit', { workspace_id: ws, kind: 'containers', csv_text: csv, duplicate_mode: 'skip' });
check('duplicate rows skipped on re-import', recommit.created === 0 && recommit.skipped === 3);

// 4. Items import into imported container by title
const itemCsv = 'Item,Container,Qty\nWreath,Import Bin A,2\nGarland,Import Bin A,\nBad Row,No Such Container,1\n';
const itemCommit = await o('api/imports', 'import_commit', { workspace_id: ws, kind: 'items', csv_text: itemCsv, duplicate_mode: 'skip' });
check('items import: 2 created, 1 error row', itemCommit.created === 2 && itemCommit.errors.length === 1, JSON.stringify(itemCommit.errors));
const aItems = (await o('api/items', 'list_items', { workspace_id: ws, container_id: importedA.id })).items;
check('imported item quantity semantics (2 and null)', aItems.find(i => i.name === 'Wreath')?.quantity === 2 && aItems.find(i => i.name === 'Garland')?.quantity === null);

// 5. Gates: free plan 402, viewer 403
const boot = await o('api/workspaces', 'bootstrap', {});
const homeId = boot.workspaces.find(w => w.name === 'Test Home')?.id;
const freeGate = await o('api/imports', 'import_analyze', { workspace_id: homeId, kind: 'containers', csv_text: csv }).then(() => null, e => e);
check('free plan import gated (402)', freeGate?.status === 402 && freeGate?.code === 'plan_limit');
const viewerGate = await v('api/imports', 'import_commit', { workspace_id: ws, kind: 'containers', csv_text: csv }).then(() => null, e => e);
check('viewer import forbidden (403)', viewerGate?.status === 403);

// 6. Undo: imported records gone, numbers stay retired
const maxBefore = Math.max(...(await o('api/containers', 'list_containers', { workspace_id: ws })).containers.map(c => c.number));
await o('api/imports', 'import_undo', { workspace_id: ws, job_id: commit.job_id });
const afterUndo = (await o('api/containers', 'list_containers', { workspace_id: ws })).containers;
check('undo removed imported containers', !afterUndo.some(c => c.title?.startsWith('Import Bin')));
const post = (await o('api/containers', 'create_container', { workspace_id: ws, location_id: state.whId, title: 'Post-undo bin', container_type: 'bin' })).container;
check('imported numbers stay retired after undo', post.number > maxBefore, `next=${post.number} max=${maxBefore}`);

// 7. Export: signed CSV with stable ids; viewer forbidden
const exp = await o('api/imports', 'export_csv', { workspace_id: ws, kind: 'workspace' });
check('export produced container+item files', exp.files.length === 2 && exp.counts.containers > 5);
const csvBody = await (await fetch(exp.files[0].url)).text();
check('export CSV has stable ids + header', csvBody.startsWith('id,number,title') && csvBody.includes(post.id));
const vExp = await v('api/imports', 'export_csv', { workspace_id: ws, kind: 'workspace' }).then(() => null, e => e);
check('viewer export forbidden (403)', vExp?.status === 403);

// 8. Reports: PDF with QR, authorization
const report = await o('api/reports', 'generate', { workspace_id: ws, kind: 'workspace', options: { include_qr: true } });
const pdfBytes = Buffer.from(await (await fetch(report.pdf_url)).arrayBuffer());
check('workspace report PDF valid', pdfBytes.subarray(0, 4).toString() === '%PDF' && report.containers > 5, `${pdfBytes.length}b, ${report.pages}p`);
const vReport = await v('api/reports', 'generate', { workspace_id: ws, kind: 'workspace' }).then(() => null, e => e);
check('viewer report forbidden (403)', vReport?.status === 403);
const missing = await o('api/reports', 'generate', { workspace_id: ws, kind: 'missing_details' });
check('missing-details report generates', missing.pdf_url && missing.containers >= 1);

// 9. Attachments: upload → register → url → replace → delete revokes
const txt = Buffer.from('warranty details for the widget');
const upFile = new File([txt], 'warranty.txt', { type: 'text/plain' });
const up = await owner.integrations.Core.UploadPrivateFile({ file: upFile });
const fileUri = up?.data?.file_uri ?? up?.file_uri;
const att = (await o('api/files', 'register_attachment', { workspace_id: ws, owner_type: 'container', owner_id: post.id, file_uri: fileUri, file_name: 'warranty.txt', content_type: 'text/plain', bytes: txt.length })).attachment;
check('attachment registered v1', att.version === 1 && att.file_name === 'warranty.txt');
const badType = await o('api/files', 'register_attachment', { workspace_id: ws, owner_type: 'container', owner_id: post.id, file_uri: fileUri, file_name: 'app.exe', content_type: 'application/octet-stream', bytes: 10 }).then(() => null, e => e);
check('disallowed type rejected (400)', badType?.status === 400);
const url1 = await o('api/files', 'get_attachment_url', { workspace_id: ws, attachment_id: att.id });
check('attachment served via signed URL', (await (await fetch(url1.url)).text()).includes('warranty details'));
const up2 = await owner.integrations.Core.UploadPrivateFile({ file: new File([Buffer.from('v2 contents')], 'warranty.txt', { type: 'text/plain' }) });
const rep = (await o('api/files', 'replace_attachment', { workspace_id: ws, attachment_id: att.id, file_uri: up2?.data?.file_uri ?? up2?.file_uri, bytes: 11 })).attachment;
check('replace bumps version', rep.version === 2);
const vAtt = await v('api/files', 'get_attachment_url', { workspace_id: ws, attachment_id: att.id }).then(() => null, e => e);
check('viewer attachment access → generic 404', vAtt?.status === 404);
await o('api/files', 'delete_attachment', { workspace_id: ws, attachment_id: att.id });
const postDelete = await o('api/files', 'get_attachment_url', { workspace_id: ws, attachment_id: att.id }).then(() => null, e => e);
check('deleted attachment no longer served', postDelete?.status === 404);

console.log(out.join('\n'));
process.exit(0);
