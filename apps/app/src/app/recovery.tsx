// Recovery ("trash"): everything soft-deleted inside its 30-day window, with
// the purge deadline stated plainly and one-tap restore.

import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { formatBytes } from "@findmybins/core";
import type { RecoveryList } from "@findmybins/api-client";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { spacing, useTheme } from "../lib/theme";
import { Button, Card, EmptyState, ErrorView, LoadingView, Screen, SectionTitle, Subtitle, Title } from "../ui";

function daysLeft(purgeAfter: string): number {
  return Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - Date.now()) / 86400_000));
}

export default function Recovery() {
  const t = useTheme();
  const { workspace } = useSession();
  const [data, setData] = useState<RecoveryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setError(null);
      setData(await api.activity.recoveryList(workspace.id));
    } catch (e: any) {
      setError(e?.status === 403
        ? "Your role can't restore deleted records."
        : "Couldn't load recently deleted records.");
    }
  }, [workspace?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!data) return <LoadingView />;

  const total = data.items.length + data.media.length + data.attachments.length;

  const restoreItem = async (id: string) => {
    if (!workspace) return;
    setBusy(id);
    try { await api.activity.restoreItem(workspace.id, id); await load(); }
    catch { /* surfaced on next load */ }
    finally { setBusy(null); }
  };
  const restoreMedia = async (id: string) => {
    if (!workspace) return;
    setBusy(id);
    try { await api.activity.restoreMedia(workspace.id, id); await load(); }
    catch { /* surfaced on next load */ }
    finally { setBusy(null); }
  };

  const Row = ({ id, title, subtitle, onRestore }: {
    id: string; title: string; subtitle: string; onRestore: () => void;
  }) => (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{title}</Text>
          <Text style={{ color: t.textMuted, fontSize: 13 }}>{subtitle}</Text>
        </View>
        <Pressable
          onPress={onRestore}
          disabled={busy === id}
          style={{
            flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8,
            borderRadius: 999, borderWidth: 1.5, borderColor: t.primary, opacity: busy === id ? 0.5 : 1,
          }}
        >
          <Ionicons name="refresh-outline" size={15} color={t.primary} />
          <Text style={{ color: t.primary, fontSize: 13, fontWeight: "600", marginLeft: 4 }}>Restore</Text>
        </Pressable>
      </View>
    </Card>
  );

  return (
    <Screen>
      <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
        <Ionicons name="arrow-back" size={24} color={t.textMuted} />
      </Pressable>
      <Title>Recently deleted</Title>
      <Subtitle>{data.note}</Subtitle>

      {total === 0 && (
        <EmptyState icon="trash-outline" title="Nothing deleted" body="Deleted items and files appear here for 30 days." />
      )}

      {data.items.length > 0 && (
        <>
          <SectionTitle>Items ({data.items.length})</SectionTitle>
          {data.items.map((i) => (
            <Row
              key={i.id} id={i.id} title={i.name}
              subtitle={`Purges in ${daysLeft(i.purge_after)} day${daysLeft(i.purge_after) === 1 ? "" : "s"}`}
              onRestore={() => restoreItem(i.id)}
            />
          ))}
        </>
      )}

      {data.media.length > 0 && (
        <>
          <SectionTitle>Photos ({data.media.length})</SectionTitle>
          {data.media.map((m) => (
            <Row
              key={m.id} id={m.id} title={`Photo · ${formatBytes(m.bytes_total)}`}
              subtitle={`Purges in ${daysLeft(m.purge_after)} days · still counts toward storage`}
              onRestore={() => restoreMedia(m.id)}
            />
          ))}
        </>
      )}

      {data.attachments.length > 0 && (
        <>
          <SectionTitle>Files ({data.attachments.length})</SectionTitle>
          {data.attachments.map((a) => (
            <Card key={a.id}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{a.file_name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 13 }}>
                {formatBytes(a.bytes)} · purges in {daysLeft(a.purge_after)} days
              </Text>
            </Card>
          ))}
        </>
      )}

      <View style={{ marginTop: spacing.lg }}>
        <Button label="Refresh" kind="ghost" icon="refresh" onPress={load} />
      </View>
    </Screen>
  );
}
