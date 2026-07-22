// Home: search, quick actions, totals, recent containers, locations, storage.

import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { formatBytes, type DashboardOverview } from "@findmybins/core";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useSync } from "../../lib/offline";
import { elevation, radius, spacing, useTheme } from "../../lib/theme";
import { Badge, Button, Card, ErrorView, LoadingView, Screen, SectionTitle, SyncPill, Title } from "../../ui";

export default function Home() {
  const t = useTheme();
  const { workspace } = useSession();
  const sync = useSync();
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setError(null);
      setData(await api.dashboard.overview(workspace.id));
    } catch {
      setError("Couldn't load your dashboard.");
    }
  }, [workspace?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { setData(null); load(); }, [workspace?.id]);

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!workspace || !data) return <LoadingView />;

  // Each stat tile carries its own accent along the top edge.
  const stat = (label: string, value: number | string, accent: string) => (
    <Card
      style={{
        flex: 1, alignItems: "center", marginHorizontal: 4,
        borderTopWidth: 3, borderTopColor: accent,
        paddingVertical: 14, paddingHorizontal: 10,
      }}
    >
      <Text style={{ color: t.text, fontSize: 22, fontWeight: "800" }}>{value}</Text>
      <Text style={{ color: t.textMuted, fontSize: 11, marginTop: 2 }}>{label}</Text>
    </Card>
  );

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Title>{workspace.name}</Title>
        <Badge label={data.workspace.plan.toUpperCase()} tone="accent" />
      </View>
      <SyncPill
        online={sync.online} syncing={sync.syncing}
        pendingCount={sync.pendingCount} conflictCount={sync.conflictCount}
        onPress={sync.conflictCount > 0 ? () => router.push("/conflicts") : undefined}
      />

      <Pressable
        onPress={() => router.push("/(tabs)/search")}
        accessibilityRole="button"
        accessibilityLabel="Search your stuff"
        style={[
          {
            flexDirection: "row", alignItems: "center", backgroundColor: t.card,
            borderRadius: radius.button, paddingHorizontal: 16, paddingVertical: 15,
            marginVertical: spacing.sm,
          },
          elevation(t).card,
        ]}
      >
        <Ionicons name="search" size={20} color={t.textMuted} />
        <Text style={{ color: t.textMuted, fontSize: 16, marginLeft: 8 }}>
          Where is it? Search your stuff…
        </Text>
      </Pressable>

      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="Scan" icon="qr-code-outline" onPress={() => router.push("/(tabs)/scan")} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Add container" icon="add" kind="secondary" onPress={() => router.push("/container/new")} />
        </View>
      </View>

      <View style={{ flexDirection: "row", marginTop: spacing.md, marginHorizontal: -4 }}>
        {stat("Containers", data.totals.containers, t.primary)}
        {stat("Items", data.totals.items, t.accent)}
        {stat("Locations", data.totals.locations, t.violet)}
      </View>

      {data.unprinted_labels > 0 && (
        <Card onPress={() => router.push("/(tabs)/containers")}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="print-outline" size={20} color={t.accent} />
            <Text style={{ color: t.text, marginLeft: spacing.sm, flex: 1 }}>
              {data.unprinted_labels} label{data.unprinted_labels === 1 ? "" : "s"} waiting to print
            </Text>
            <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
          </View>
        </Card>
      )}

      <SectionTitle>Recent containers</SectionTitle>
      {data.recent_containers.map((c) => (
        <Card key={c.id} onPress={() => router.push(`/container/${c.id}`)}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={{
                backgroundColor: `${t.primary}18`, borderRadius: radius.sm,
                paddingHorizontal: 10, paddingVertical: 6, marginRight: spacing.sm,
              }}
            >
              <Text style={{ color: t.primary, fontWeight: "700" }}>{c.number_display ?? "—"}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>{c.title}</Text>
              {c.location_path ? (
                <Text style={{ color: t.textMuted, fontSize: 13 }} numberOfLines={1}>{c.location_path}</Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
          </View>
        </Card>
      ))}

      <SectionTitle>Locations</SectionTitle>
      {data.locations.map((l) => (
        <Card key={l.id}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="location-outline" size={20} color={t.accent} />
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600", marginLeft: spacing.sm, flex: 1 }}>
              {l.name}
            </Text>
            <Text style={{ color: t.textMuted, fontSize: 13 }}>
              {l.container_count} container{l.container_count === 1 ? "" : "s"}
            </Text>
          </View>
        </Card>
      ))}

      <Card style={{ marginTop: spacing.md }}>
        <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 6 }}>
          Storage: {formatBytes(data.storage.bytes_used)} of {formatBytes(data.storage.bytes_limit)} used
        </Text>
        <View style={{ height: 5, borderRadius: 99, backgroundColor: t.elevated, overflow: "hidden" }}>
          <View
            style={{
              width: `${Math.min(100, Math.round((data.storage.bytes_used / data.storage.bytes_limit) * 100))}%`,
              height: "100%", borderRadius: 99, backgroundColor: t.primary,
            }}
          />
        </View>
      </Card>
    </Screen>
  );
}
