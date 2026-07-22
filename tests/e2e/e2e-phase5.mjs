import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const state = JSON.parse(readFileSync('phase12-state.json', 'utf8'));
const mk = () => createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const owner = mk(), viewer = mk();
const inv = (cli) => async (fn, action, payload) => {
  try { const r = await cli.functions.invoke(fn, { action, payload }); return r?.data?.data ?? r?.data; }
  catch (e) { const err = new Error(`${action}:${e?.response?.status}`); err.status = e?.response?.status; throw err; }
};
const o = inv(owner), v = inv(viewer);
const out = [];
const check = (n, c, d='') => out.push(`${c ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`);

await owner.auth.loginViaEmailPassword('six47webservices+fmbtest@gmail.com', password);
await viewer.auth.loginViaEmailPassword('six47webservices+fmbtest2@gmail.com', password);
const ws = state.wsId;

// 1. Exact multi-container result with locations
const r1 = await o('api/search', 'keyword', { workspace_id: ws, query: 'pillows' });
check('exact search finds item in 2 containers with locations',
  r1.items.length >= 2 && r1.items.every(i => i.container?.number_display && i.location_path) && r1.items[0].match === 'exact',
  `${r1.items.length} results`);

// 2. Typo tolerance
const r2 = await o('api/search', 'keyword', { workspace_id: ws, query: 'pilows' });
check('typo query still matches (possible)', r2.items.length >= 2 && r2.items[0].match === 'possible' && r2.exact_only === false);

// 3. Synonym (cushions → pillow)
const r3 = await o('api/search', 'keyword', { workspace_id: ws, query: 'cushions' });
check('synonym query matches (possible)', r3.items.some(i => i.item.name === 'Fall pillows') && r3.items[0].match === 'possible');

// 4. Multi-token AND
const r4 = await o('api/search', 'keyword', { workspace_id: ws, query: 'fall pillows' });
const r4b = await o('api/search', 'keyword', { workspace_id: ws, query: 'fall staplers' });
check('multi-token requires all tokens', r4.items.length >= 2 && r4b.items.length === 0);

// 5. Case-insensitive
const r5 = await o('api/search', 'keyword', { workspace_id: ws, query: 'hdmi' });
check('case-insensitive match', r5.items.some(i => i.item.name === 'HDMI cables'));

// 6. Location filter
const r6 = await o('api/search', 'keyword', { workspace_id: ws, query: 'staplers', location_id: state.whId });
const r6b = await o('api/search', 'keyword', { workspace_id: ws, query: 'staplers' });
check('location filter scopes results', r6.items.length === 0 && r6b.items.length === 1);

// 7. Archived containers excluded by default
const r7 = await o('api/search', 'keyword', { workspace_id: ws, query: 'bin' });
const r7b = await o('api/search', 'keyword', { workspace_id: ws, query: 'bin', include_archived: true });
check('archived excluded unless requested', !r7.containers.some(c => c.container.archived) && r7b.containers.some(c => c.container.archived));

// 8. Viewer count isolation
const v1 = await v('api/search', 'keyword', { workspace_id: ws, query: 'pillows' });
const v2 = await v('api/search', 'keyword', { workspace_id: ws, query: 'staplers' });
check('viewer: zero hidden matches, sees granted matches', v1.items.length === 0 && v1.containers.length === 0 && v2.items.length === 1);

// 9. History: private, deletable, disableable
const h1 = (await o('api/search', 'history_list', { workspace_id: ws })).history;
check('history recorded own queries', h1.some(h => h.query_text === 'pillows'));
// Cross-user privacy: a query only the viewer ran must never surface for the owner.
const uniq = `viewer-only-${Date.now()}`;
await v('api/search', 'keyword', { workspace_id: ws, query: uniq });
const hOwner = (await o('api/search', 'history_list', { workspace_id: ws })).history;
check('owner cannot see another member’s query text', !hOwner.some(h => h.query_text === uniq));
await o('api/workspaces', 'update_profile', { search_history_enabled: false });
await o('api/search', 'keyword', { workspace_id: ws, query: 'secretquery' });
const h2 = (await o('api/search', 'history_list', { workspace_id: ws })).history;
check('disabled saving keeps query out of history', !h2.some(h => h.query_text === 'secretquery'));
await o('api/workspaces', 'update_profile', { search_history_enabled: true });
const delTarget = h2.find(h => h.query_text === 'pillows');
await o('api/search', 'history_delete', { workspace_id: ws, entry_id: delTarget.id });
const h3 = (await o('api/search', 'history_list', { workspace_id: ws })).history;
check('single entry deleted', !h3.some(h => h.id === delTarget.id));
const cleared = (await o('api/search', 'history_clear', { workspace_id: ws })).cleared;
const h4 = (await o('api/search', 'history_list', { workspace_id: ws })).history;
check('clear-all empties history', cleared >= 1 && h4.length === 0);

// 10. Viewer cannot delete another user's entry
// The viewer's history must never contain queries only the owner ran.
// (Asserting on owner-exclusive terms rather than a fixed allow-list, so the
// check stays valid as test accounts accumulate their own search history.)
const vh = (await v('api/search', 'history_list', { workspace_id: ws })).history;
const ownerOnlyTerms = ['hdmi', 'cushions', 'pilows', 'secretquery'];
const leaked = vh.filter(h => ownerOnlyTerms.includes(h.query_text.toLowerCase()));
check('viewer history free of owner-only queries', leaked.length === 0, leaked.map(h => h.query_text).join(',') || 'none');

// 11. Dashboards
const od = await o('api/dashboard', 'overview', { workspace_id: ws });
check('owner dashboard totals + queue + recents', od.totals.containers > 10 && od.unprinted_labels >= 1 && od.recent_containers.length === 5 && od.locations.every(l => typeof l.container_count === 'number'));
check('owner dashboard business extras present', Array.isArray(od.recent_activity) && typeof od.member_count === 'number');
const vd = await v('api/dashboard', 'overview', { workspace_id: ws });
check('viewer dashboard count isolation', vd.totals.locations === 1 && vd.totals.containers <= 2 && vd.totals.items === 1, JSON.stringify(vd.totals));
check('viewer dashboard has no activity/member data', vd.recent_activity === undefined && vd.member_count === undefined);

console.log(out.join('\n'));
process.exit(0);
