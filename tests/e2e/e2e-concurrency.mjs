import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
const base44 = createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const state = JSON.parse(readFileSync('phase12-state.json', 'utf8'));
const invoke = async (fn, action, payload) => {
  try { const r = await base44.functions.invoke(fn, { action, payload }); return r?.data?.data ?? r?.data; }
  catch (e) { const err = new Error(`${action} -> ${e?.response?.status} ${JSON.stringify(e?.response?.data)}`); err.code = e?.response?.data?.error; throw err; }
};
await base44.auth.loginViaEmailPassword('six47webservices+fmbtest@gmail.com', password);
const wsId = state.wsId;

// Baseline: current max number in workspace
const all = [
  ...(await invoke('api/containers', 'list_containers', { workspace_id: wsId })).containers,
  ...(await invoke('api/containers', 'list_containers', { workspace_id: wsId, archived_filter: true })).containers,
];
const baselineMax = Math.max(...all.map(c => c.number));
console.log('baseline max number:', baselineMax, '(existing dupes from pre-fix run are expected test debris)');

// 10 concurrent creates with the fixed allocator
const creations = await Promise.all(Array.from({ length: 10 }, (_, i) =>
  invoke('api/containers', 'create_container', { workspace_id: wsId, location_id: state.whId, title: `Race ${i}`, container_type: 'tote' })
    .then(r => r.container, e => ({ error: String(e) }))
));
const ok = creations.filter(c => !c.error);
const nums = ok.map(c => c.number).sort((a, b) => a - b);
console.log(ok.length === 10 ? 'PASS all 10 creates succeeded' : `FAIL creates: ${creations.filter(c=>c.error).map(c=>c.error).join(' | ')}`);
console.log(new Set(nums).size === nums.length ? 'PASS numbers unique' : `FAIL duplicate numbers: ${nums.join(',')}`);
console.log(nums[0] === baselineMax + 1 && nums[nums.length-1] === baselineMax + nums.length
  ? `PASS contiguous ${nums[0]}..${nums[nums.length-1]}` : `FAIL not contiguous: ${nums.join(',')}`);
process.exit(0);
