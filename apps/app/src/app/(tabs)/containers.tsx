// Containers: browsable list with archived filter.

import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { containerTypeLabel, type Container } from "@findmybins/core";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { offlineContainers, useSync } from "../../lib/offline";
import { radius, spacing, useTheme } from "../../lib/theme";
import { Badge, Button, Card, EmptyState, ErrorView, LoadingView, Screen, SyncPill, Title } from "../../ui";

export default function Containers() {
  const t = useTheme();
  const { workspace } = useSession();
  const sync = useSync();
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const loadFromCache = useCallback(() => {
    if (!workspace) return false;
    const cached = offlineContainers(workspace.id)
      .filter((c) => !!c.archived === showArchived)
      .map((c) => ({ ...c, number_display: c.number_display ?? null, qr_link: null }));
    setContainers(cached as Container[]);
    setFromCache(true);
    return cached.length > 0;
  }, [workspace?.id, showArchived]);

  const load = useCallback(async () => {
    if (!workspace) return;
    if (!sync.online) {
      setError(null);
      loadFromCache();
      return;
    }
    try {
      setError(null);
      const res = await api.containers.list(workspace.id, { archived_filter: showArchived });
      setContainers(res.containers);
      setFromCache(false);
    } catch {
      if (!loadFromCache()) setError("Couldn't load containers.");
    }
  }, [workspace?.id, showArchived, sync.online, loadFromCache]);

  useFocusEffect(useCallback(() => {
    load();
    if (workspace && sync.online) sync.syncNow(workspace.id);
  }, [load, workspace?.id, sync.online]));

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!containers) return <LoadingView />;

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Title>Containers</Title>
        <Pressable onPress={() => { setContainers(null); setShowArchived(!showArchived); }}>
          <Text style={{ color: t.primary, fontSize: 14, fontWeight: "600" }}>
            {showArchived ? "Show active" : "Show archived"}
          </Text>
        </Pressable>
      </View>

      <SyncPill
        online={sync.online} syncing={sync.syncing}
        pendingCount={sync.pendingCount} conflictCount={sync.conflictCount}
        onPress={sync.conflictCount > 0 ? () => router.push("/conflicts") : undefined}
      />
      {fromCache && (
        <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: spacing.sm }}>
          Showing locally cached data{sync.lastSyncAt ? ` from ${new Date(sync.lastSyncAt).toLocaleString()}` : ""}.
        </Text>
      )}

      <Button label="New container" icon="add" onPress={() => router.push("/container/new")} />

      {containers.length === 0 && (
        <EmptyState
          icon="cube-outline"
          title={showArchived ? "No archived containers" : "No containers yet"}
          body={showArchived ? undefined : "Create your first container and print its QR label in under a minute."}
        />
      )}

      {containers.map((c) => (
        <Card key={c.id} onPress={() => router.push(`/container/${c.id}`)}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={{
                backgroundColor: `${t.primary}18`, borderRadius: radius.sm,
                paddingHorizontal: 10, paddingVertical: 6, marginRight: spacing.sm, minWidth: 52,
                alignItems: "center",
              }}
            >
              <Text style={{ color: t.primary, fontWeight: "700" }}>
                {c.pending_number ? "…" : c.number_display ?? "—"}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>{c.title}</Text>
              <Text style={{ color: t.textMuted, fontSize: 13 }} numberOfLines={1}>
                {containerTypeLabel(c.container_type, c.custom_type_label)}
                {c.location_path ? ` · ${c.location_path}` : ""}
              </Text>
            </View>
            {c.archived && <Badge label="Archived" />}
            {!c.archived && c.label_status !== "printed" && <Badge label="Label" tone="warn" />}
            <Ionicons name="chevron-forward" size={18} color={t.textMuted} style={{ marginLeft: 6 }} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
