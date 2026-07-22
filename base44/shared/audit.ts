// Audit trail writer. Called in the same request as the mutation it records.
// NEVER pass search query text or file URIs/tokens in metadata.

import { safeError } from "./http.ts";

const CRITICAL_ACTIONS = new Set([
  "ownership.transferred",
  "workspace.deletion_requested",
  "workspace.deletion_canceled",
  "workspace.permanently_deleted",
  "member.role_changed",
  "member.removed",
  "grant.changed",
  "subscription.changed",
  "security.settings_changed",
]);

export interface AuditInput {
  workspace_id: string;
  actor?: { id: string; email: string };
  action: string;
  target_type?: string;
  target_id?: string;
  target_label?: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(sr: any, evt: AuditInput): Promise<void> {
  try {
    await sr.entities.ActivityEvent.create({
      workspace_id: evt.workspace_id,
      actor_user_id: evt.actor?.id,
      actor_email: evt.actor?.email,
      action: evt.action,
      target_type: evt.target_type,
      target_id: evt.target_id,
      target_label: evt.target_label,
      metadata: evt.metadata ?? {},
      critical: CRITICAL_ACTIONS.has(evt.action),
    });
  } catch (err) {
    // Auditing must never take the primary operation down, but the gap is logged.
    console.error(`[audit] failed to record ${evt.action}:`, safeError(err));
  }
}
