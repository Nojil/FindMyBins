// Sync conflict review. Both versions are shown; nothing is resolved silently.

import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSession } from "../lib/session";
import {
  offlineConflicts, resolveConflictKeepMine, resolveConflictKeepServer, useSync,
} from "../lib/offline";
import { spacing, useTheme } from "../lib/theme";
import { Button, Card, EmptyState, Screen, Subtitle, Title } from "../ui";

const REASON_LABELS: Record<string, string> = {
  quantity: "Quantity changed in two places",
  archived_vs_edit: "Edited here, archived elsewhere",
  delete_vs_edit: "Deleted here, edited elsewhere",
  incompatible_move: "Moved in two places",
};

export default function Conflicts() {
  const t = useTheme();
  const { workspace } = useSession();
  const sync = useSync();
  const [conflicts, setConflicts] = useState<Array<{ id: string; data: any }>>([]);

  const load = useCallback(() => {
    if (!workspace) return;
    setConflicts(offlineConflicts(workspace.id));
    sync.refreshCounts(workspace.id);
  }, [workspace?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen>
      <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
        <Ionicons name="arrow-back" size={24} color={t.textMuted} />
      </Pressable>
      <Title>Sync conflicts</Title>
      <Subtitle>These changes happened in two places. Pick which version to keep.</Subtitle>

      {conflicts.length === 0 && (
        <EmptyState icon="checkmark-done-outline" title="All clear" body="No conflicts need your attention." />
      )}

      {conflicts.map(({ id, data }) => {
        const server = data.server_record ?? {};
        const mine = data.client_payload?.patch ?? data.client_payload ?? {};
        const name = server.name ?? server.title ?? "Record";
        const canKeepMine = data.reason === "quantity" || data.reason === "delete_vs_edit" || data.reason === "incompatible_move";
        return (
          <Card key={id}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: "700" }}>{name}</Text>
            <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.sm }}>
              {REASON_LABELS[data.reason] ?? data.reason}
            </Text>
            <View style={{ marginBottom: spacing.sm }}>
              <Text style={{ color: t.text, fontSize: 14 }}>
                Server version: {data.reason === "quantity" ? `quantity ${server.quantity ?? "not specified"}` : JSON.stringify(server.title ?? server.name)}
              </Text>
              <Text style={{ color: t.text, fontSize: 14 }}>
                Your version: {data.reason === "quantity" ? `quantity ${mine.quantity ?? "not specified"}` : "your offline change"}
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Keep server" kind="secondary"
                  onPress={() => { resolveConflictKeepServer(id); load(); }}
                />
              </View>
              {canKeepMine && workspace && (
                <View style={{ flex: 1 }}>
                  <Button
                    label="Keep mine"
                    onPress={() => {
                      resolveConflictKeepMine(workspace.id, id, data);
                      if (sync.online) sync.syncNow(workspace.id);
                      load();
                    }}
                  />
                </View>
              )}
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
