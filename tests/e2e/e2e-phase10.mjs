import { createClient } from '@base44/sdk';
import { readFileSync } from 'fs';
const password = (process.env.FMB_TEST_PASSWORD ?? '').trim();
const state = JSON.parse(readFileSync('phase12-state.json', 'utf8'));
const mk = () => createClient({ appId: '6a5fd45e9129f5171ccbb963' });
const owner = mk(), other = mk();
const inv = (cli) => async (fn, action, payload) => {
  try { const r = await cli.functions.invoke(fn, { action, payload }); return r?.data?.data ?? r?.data; }
  catch (e) { const err = new Error(`${action}:${e?.response?.status}`); err.status = e?.response?.status; err.code = e?.response?.data?.error; throw err; }
};
const o = inv(owner), x = inv(other);
const out = [];
const check = (n, c, d='') => out.push(`${c ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`);

await owner.auth.loginViaEmailPassword('six47webservices+fmbtest@gmail.com', password);
await other.auth.loginViaEmailPassword('six47webservices+fmbtest2@gmail.com', password);
const ws = state.wsId;

// ===== ACTIVITY LOG =====
const act = await o('api/activity', 'list', { workspace_id: ws, limit: 20 });
check('activity log returns events + retention window', act.events.length > 0 && act.retention_days === 1095, `${act.events.length} events, ${act.retention_days}d`);
check('activity log carries no search query text', !JSON.stringify(act.events).toLowerCase().includes('pillows') || act.events.every(e => e.action !== 'search'));
const vAct = await x('api/activity', 'list', { workspace_id: ws }).then(() => null, e => e);
check('viewer cannot read activity log (403)', vAct?.status === 403);

// ===== RECOVERY =====
const cs = (await o('api/containers', 'list_containers', { workspace_id: ws })).containers;
const target = cs.find(c => c.location_id === state.whId);
const tmpItem = (await o('api/items', 'create_item', { workspace_id: ws, container_id: target.id, name: 'Recovery Probe' })).item;
await o('api/items', 'delete_item', { workspace_id: ws, item_id: tmpItem.id });
const rec = await o('api/activity', 'recovery_list', { workspace_id: ws });
const found = rec.items.find(i => i.id === tmpItem.id);
check('deleted item appears in recovery with purge deadline', !!found && !!found.purge_after);
const daysLeft = Math.round((new Date(found.purge_after) - Date.now()) / 86400000);
check('recovery window is 30 days', daysLeft === 30, `${daysLeft}d`);
const vRec = await x('api/activity', 'recovery_list', { workspace_id: ws }).then(() => null, e => e);
check('viewer cannot list recovery (403)', vRec?.status === 403);
await o('api/items', 'restore_deleted', { workspace_id: ws, item_id: tmpItem.id });

// ===== THROWAWAY WORKSPACE: transfer + deletion lifecycle =====
const tmpWs = (await o('api/workspaces', 'create_workspace', { name: 'Lifecycle Test WS', workspace_type: 'business' })).workspace;
const invite = await o('api/members', 'create_invitation', { workspace_id: tmpWs.id, kind: 'link', invite_role: 'admin' });
await x('api/members', 'accept_invitation', { token: invite.link.split('/join/')[1], confirm_13_or_over: true });
const members = (await o('api/members', 'list_members', { workspace_id: tmpWs.id })).members;
const adminMember = members.find(m => m.member_role === 'admin');
check('second user joined as admin', !!adminMember);

// Transfer guards
const badConfirm = await o('api/workspaces', 'transfer_ownership', { workspace_id: tmpWs.id, member_id: adminMember.id, confirm_name: 'wrong' }).then(() => null, e => e);
check('transfer without exact typed name rejected (400)', badConfirm?.status === 400);
const notAdmin = members.find(m => m.member_role === 'owner');
const selfTransfer = await o('api/workspaces', 'transfer_ownership', { workspace_id: tmpWs.id, member_id: notAdmin.id, confirm_name: 'Lifecycle Test WS' }).then(() => null, e => e);
check('cannot transfer to the current owner (403/400)', selfTransfer !== null);

// Real transfer
const transferred = await o('api/workspaces', 'transfer_ownership', { workspace_id: tmpWs.id, member_id: adminMember.id, confirm_name: 'Lifecycle Test WS' });
check('ownership transferred', transferred.transferred === true);
const afterMembers = (await x('api/members', 'list_members', { workspace_id: tmpWs.id })).members;
const newOwner = afterMembers.find(m => m.member_role === 'owner');
const demoted = afterMembers.find(m => m.user_email?.includes('+fmbtest@'));
check('new owner set, old owner demoted to admin', newOwner?.id === adminMember.id && demoted?.member_role === 'admin');
const exOwnerDelete = await o('api/workspaces', 'request_workspace_deletion', { workspace_id: tmpWs.id, confirm_name: 'Lifecycle Test WS' }).then(() => null, e => e);
check('demoted ex-owner can no longer delete workspace (403)', exOwnerDelete?.status === 403);

// Transfer back so the original account owns it for cleanup
await x('api/workspaces', 'transfer_ownership', { workspace_id: tmpWs.id, member_id: demoted.id, confirm_name: 'Lifecycle Test WS' });
check('ownership transferred back', (await o('api/members', 'list_members', { workspace_id: tmpWs.id })).members.find(m => m.member_role === 'owner')?.user_email?.includes('+fmbtest@'));

// ===== DELETION LIFECYCLE =====
const delReq = await o('api/workspaces', 'request_workspace_deletion', { workspace_id: tmpWs.id, confirm_name: 'Lifecycle Test WS' });
const windowDays = Math.round((new Date(delReq.effective_at) - Date.now()) / 86400000);
check('deletion scheduled with 30-day window', delReq.status === 'pending_deletion' && windowDays === 30, `${windowDays}d`);
const memberBlocked = await x('api/workspaces', 'get_workspace', { workspace_id: tmpWs.id }).then(() => null, e => e);
check('members blocked during deletion window (404)', memberBlocked?.status === 404);
const ownerView = await o('api/workspaces', 'get_workspace', { workspace_id: tmpWs.id });
check('owner still sees workspace + deletion info', ownerView.workspace.status === 'pending_deletion' && !!ownerView.workspace.deletion?.effective_at);
const dup = await o('api/workspaces', 'request_workspace_deletion', { workspace_id: tmpWs.id, confirm_name: 'Lifecycle Test WS' }).then(() => null, e => e);
check('duplicate deletion request rejected (400)', dup?.status === 400);
await o('api/workspaces', 'cancel_workspace_deletion', { workspace_id: tmpWs.id });
check('deletion canceled restores access', (await x('api/workspaces', 'get_workspace', { workspace_id: tmpWs.id })).workspace.status === 'active');

// ===== ACCOUNT DELETION GUARD =====
const acct = await o('api/workspaces', 'account_deletion_status', {});
check('account deletion blocked while owning workspaces', acct.can_delete === false && acct.owned_workspaces.length >= 1, `${acct.owned_workspaces.length} owned`);
const acctDel = await o('api/workspaces', 'delete_account', { confirm: 'DELETE' }).then(() => null, e => e);
check('delete_account refuses while owning workspaces (400)', acctDel?.status === 400);

// ===== MAINTENANCE SWEEP =====
const sweep = await fetch('https://base44.app/api/apps/6a5fd45e9129f5171ccbb963/functions/maintenance-sweep', { method: 'POST' });
const sweepBody = await sweep.json().catch(() => ({}));
check('maintenance sweep executes', sweep.ok && sweepBody.ok === true, JSON.stringify(sweepBody).slice(0, 120));
// Nothing should have been purged: our probe item was restored, window is 30d away.
const recAfter = await o('api/activity', 'recovery_list', { workspace_id: ws });
check('sweep did not purge in-window records', !recAfter.items.some(i => i.id === tmpItem.id));

// Cleanup: schedule the throwaway workspace for deletion
await o('api/workspaces', 'request_workspace_deletion', { workspace_id: tmpWs.id, confirm_name: 'Lifecycle Test WS' }).catch(() => {});

console.log(out.join('\n'));
process.exit(0);
