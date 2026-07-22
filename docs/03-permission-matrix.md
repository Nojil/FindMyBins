# FindMyBins — Permission Matrix

Enforced server-side in `base44/shared/authz.ts`. In Business/Organization workspaces, Manager/Contributor/Viewer act **only within locations granted via LocationGrant** (inherited by all descendants). Owner and Admin always have all-location access. Household workspaces show simplified role names (Owner/Member/Viewer) mapping to Owner/Contributor/Viewer.

| Capability | Owner | Admin | Manager | Contributor | Viewer | Billing Admin |
|---|---|---|---|---|---|---|
| View / search / scan authorized inventory | ✅ | ✅ | ✅◐ | ✅◐ | ✅◐ | ❌* |
| Create/edit containers & items | ✅ | ✅ | ✅◐ | ✅◐ | ❌ | ❌ |
| Archive/restore containers & items | ✅ | ✅ | ✅◐ | ❌ | ❌ | ❌ |
| Move containers across locations | ✅ | ✅ | ✅◐ (both ends) | ❌ | ❌ | ❌ |
| Manage locations (create/rename/archive) | ✅ | ✅ | ✅◐ | ❌ | ❌ | ❌ |
| Print/reprint labels, print queue | ✅ | ✅ | ✅◐ | ✅◐ | ❌ | ❌ |
| Edit container numbers (unique only) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Custom field definitions | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite members / approve join requests | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Assign roles & location grants | ✅ | ✅ (not owner's) | ❌ | ❌ | ❌ | ❌ |
| Remove members | ✅ | ✅ (not owner) | ❌ | ❌ | ❌ | ❌ |
| CSV import / undo import | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| CSV export (distinct permission) | ✅ | ✅ | ✅◐ | ❌ | ❌ | ❌ |
| Generate PDF reports | ✅ | ✅ | ✅◐ | ❌ | ❌ | ❌ |
| View activity log | ✅ | ✅ | ✅◐ | ❌ | ❌ | ❌ |
| Workspace settings (offline policy, templates) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Billing, plan, seats | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Require MFA (when available) / security settings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Ownership transfer (to an admin, reauth) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Workspace deletion / restore / permanent delete | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Recover deleted items/media (30-day window) | ✅ | ✅ | ✅◐ | ❌ | ❌ | ❌ |

◐ = within granted locations only (Business/Organization). \* Billing Admin gets no inventory access automatically; a separate membership role may be granted additionally.

Invariants enforced in code: exactly one owner per workspace; owner cannot be removed or downgraded except via transfer; owner cannot delete their account while owning a workspace; membership removal revokes access immediately (server-checked per request); Billing-Admin actions and all permission changes are audited; search-history text is invisible to every role except its author.
