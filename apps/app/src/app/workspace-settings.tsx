// Workspace settings: members, activity, and the owner-only danger zone
// (ownership transfer and workspace deletion). Destructive actions require
// typing the workspace name exactly — the same gate the server enforces.

import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { ActivityEvent } from "@findmybins/api-client";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { radius, spacing, useTheme } from "../lib/theme";
import { Badge, Button, Card, ErrorView, LoadingView, Screen, SectionTitle, Subtitle, TextField, Title } from "../ui";

interface Member {
  id: string; user_email: string; member_role: string; status: string;
}

export default function WorkspaceSettings() {
  const t = useTheme();
  const { workspace, refresh } = useSession();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [deletion, setDeletion] = useState<{ effective_at: string } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = workspace?.my_role === "owner";
  const canManage = isOwner || workspace?.my_role === "admin";

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setError(null);
      const ws = await api.workspaces.get(workspace.id);
      setDeletion((ws.workspace as any).deletion ?? null);
      if (canManage) {
        const m = await api.members.list(workspace.id);
        setMembers(m.members as Member[]);
        const a = await api.activity.list(workspace.id, 15).catch(() => ({ events: [], retention_days: 0 }));
        setEvents(a.events);
      } else {
        setMembers([]);
      }
    } catch {
      setError("Couldn't load workspace settings.");
    }
  }, [workspace?.id, canManage]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!workspace || members === null) return <LoadingView />;

  const nameMatches = confirmText === workspace.name;

  const doTransfer = async () => {
    if (!transferTo || !nameMatches) return;
    setBusy(true); setNote(null);
    try {
      await api.workspacesExtra.transferOwnership(workspace.id, transferTo, confirmText);
      setConfirmText(""); setTransferTo(null);
      await refresh(); await load();
      setNote("Ownership transferred. You are now an admin.");
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't transfer ownership.");
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!nameMatches) return;
    setBusy(true); setNote(null);
    try {
      const res = await api.workspacesExtra.requestDeletion(workspace.id, confirmText);
      setConfirmText("");
      setDeletion({ effective_at: res.effective_at });
      setNote(`Scheduled for deletion on ${new Date(res.effective_at).toLocaleDateString()}.`);
      await load();
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't schedule deletion.");
    } finally { setBusy(false); }
  };

  const cancelDelete = async () => {
    setBusy(true); setNote(null);
    try {
      await api.workspacesExtra.cancelDeletion(workspace.id);
      setDeletion(null);
      setNote("Deletion canceled. The workspace is active again.");
      await load();
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't cancel deletion.");
    } finally { setBusy(false); }
  };

  const admins = members.filter((m) => m.member_role === "admin");

  return (
    <Screen>
      <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
        <Ionicons name="arrow-back" size={24} color={t.textMuted} />
      </Pressable>
      <Title>{workspace.name}</Title>
      <Subtitle>{workspace.workspace_type} · your role: {workspace.my_role}</Subtitle>

      {deletion && (
        <Card style={{ borderColor: t.danger, borderWidth: 2 }}>
          <Text style={{ color: t.danger, fontSize: 15, fontWeight: "700" }}>Scheduled for deletion</Text>
          <Text style={{ color: t.text, fontSize: 14, marginTop: 4 }}>
            All data is permanently removed on {new Date(deletion.effective_at).toLocaleDateString()}.
            Members can't access it in the meantime.
          </Text>
          {isOwner && (
            <View style={{ marginTop: spacing.sm }}>
              <Button label="Restore workspace" icon="refresh-outline" onPress={cancelDelete} loading={busy} />
            </View>
          )}
        </Card>
      )}

      {canManage && (
        <>
          <SectionTitle>Members ({members.length})</SectionTitle>
          {members.map((m) => (
            <Card key={m.id}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 15 }}>{m.user_email}</Text>
                </View>
                <Badge label={m.member_role} tone={m.member_role === "owner" ? "accent" : "neutral"} />
              </View>
            </Card>
          ))}

          <SectionTitle>Recent activity</SectionTitle>
          {events.length === 0 && <Text style={{ color: t.textMuted, fontSize: 13 }}>No recent activity.</Text>}
          {events.map((e) => (
            <Card key={e.id}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 14 }}>
                    {e.action.replace(/[._]/g, " ")}{e.target_label ? ` — ${e.target_label}` : ""}
                  </Text>
                  <Text style={{ color: t.textMuted, fontSize: 12 }}>
                    {e.actor_email ?? "system"} · {new Date(e.created_date).toLocaleString()}
                  </Text>
                </View>
                {e.critical && <Badge label="security" tone="warn" />}
              </View>
            </Card>
          ))}
        </>
      )}

      <Card onPress={() => router.push("/recovery")}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name="trash-outline" size={20} color={t.accent} />
          <Text style={{ color: t.text, fontSize: 15, marginLeft: spacing.sm, flex: 1 }}>Recently deleted</Text>
          <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
        </View>
      </Card>

      {isOwner && !deletion && (
        <>
          <SectionTitle>Danger zone</SectionTitle>
          <Card style={{ borderColor: t.danger, borderWidth: 1 }}>
            <Text style={{ color: t.text, fontSize: 14, marginBottom: spacing.sm }}>
              Type the workspace name exactly to enable these actions.
            </Text>
            <TextField
              value={confirmText}
              onChangeText={setConfirmText}
              placeholder={workspace.name}
              autoCapitalize="none"
              accessibilityLabel="Type the workspace name to confirm"
            />

            {admins.length > 0 && (
              <>
                <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600", marginBottom: 6 }}>
                  Transfer ownership to an admin
                </Text>
                {admins.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => setTransferTo(m.id)}
                    style={{
                      padding: spacing.sm, borderRadius: radius.sm, marginBottom: 6,
                      borderWidth: transferTo === m.id ? 2 : 1,
                      borderColor: transferTo === m.id ? t.primary : t.border,
                    }}
                  >
                    <Text style={{ color: t.text, fontSize: 14 }}>{m.user_email}</Text>
                  </Pressable>
                ))}
                <Button
                  label="Transfer ownership"
                  kind="secondary"
                  onPress={doTransfer}
                  disabled={!nameMatches || !transferTo}
                  loading={busy}
                />
              </>
            )}

            <View style={{ marginTop: spacing.md }}>
              <Button
                label="Delete this workspace"
                kind="danger"
                icon="warning-outline"
                onPress={doDelete}
                disabled={!nameMatches}
                loading={busy}
              />
              <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 6 }}>
                Starts a 30-day recovery window. Nothing is removed until it ends, and you can restore at any time.
              </Text>
            </View>
          </Card>
        </>
      )}

      {note && (
        <Card style={{ marginTop: spacing.md }}>
          <Text style={{ color: t.text, fontSize: 14 }}>{note}</Text>
        </Card>
      )}
    </Screen>
  );
}
