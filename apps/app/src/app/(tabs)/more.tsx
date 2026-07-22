// More: workspace switcher, print queue, account, sign out.

import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { spacing, useTheme } from "../../lib/theme";
import { Badge, Button, Card, Screen, SectionTitle, Title } from "../../ui";

export default function More() {
  const t = useTheme();
  const { profile, workspace, workspaces, selectWorkspace, signOut } = useSession();
  const [queueCount, setQueueCount] = useState<number | null>(null);

  useFocusEffect(useCallback(() => {
    (async () => {
      if (!workspace) return;
      try {
        const res = await api.labels.queue(workspace.id);
        setQueueCount(res.queue.length);
      } catch { setQueueCount(null); }
    })();
  }, [workspace?.id]));

  return (
    <Screen>
      <Title>More</Title>

      <SectionTitle>Workspaces</SectionTitle>
      {workspaces.map((w) => (
        <Card key={w.id} onPress={() => selectWorkspace(w.id)}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons
              name={w.workspace_type === "household" ? "home-outline" : "business-outline"}
              size={20}
              color={w.id === workspace?.id ? t.primary : t.textMuted}
            />
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{w.name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>
                {w.workspace_type} · {w.my_role} · {w.plan}
              </Text>
            </View>
            {w.id === workspace?.id && <Ionicons name="checkmark-circle" size={20} color={t.primary} />}
          </View>
        </Card>
      ))}

      <SectionTitle>Workspace</SectionTitle>
      <Card onPress={() => router.push("/workspace-settings")}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name="settings-outline" size={20} color={t.accent} />
          <Text style={{ color: t.text, fontSize: 15, marginLeft: spacing.sm, flex: 1 }}>
            Settings, members & activity
          </Text>
          <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
        </View>
      </Card>
      <Card onPress={() => router.push("/recovery")}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name="trash-outline" size={20} color={t.accent} />
          <Text style={{ color: t.text, fontSize: 15, marginLeft: spacing.sm, flex: 1 }}>Recently deleted</Text>
          <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
        </View>
      </Card>

      <SectionTitle>Labels</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name="print-outline" size={20} color={t.accent} />
          <Text style={{ color: t.text, fontSize: 15, marginLeft: spacing.sm, flex: 1 }}>Print queue</Text>
          {queueCount != null && <Badge label={String(queueCount)} tone={queueCount > 0 ? "warn" : "neutral"} />}
        </View>
      </Card>

      {(workspace?.my_role === "owner" || workspace?.my_role === "billing_admin") && (
        <>
          <SectionTitle>Billing</SectionTitle>
          <Card onPress={() => router.push("/billing")}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Ionicons name="card-outline" size={20} color={t.accent} />
              <Text style={{ color: t.text, fontSize: 15, marginLeft: spacing.sm, flex: 1 }}>Plan & billing</Text>
              <Badge label={(workspace?.plan ?? "free").toUpperCase()} tone="accent" />
              <Ionicons name="chevron-forward" size={18} color={t.textMuted} style={{ marginLeft: 6 }} />
            </View>
          </Card>
        </>
      )}

      <SectionTitle>Account</SectionTitle>
      <Card>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>
          {profile?.display_name || "Your account"}
        </Text>
        <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>
          Theme follows your device setting.
        </Text>
      </Card>

      <View style={{ marginTop: spacing.lg }}>
        <Button
          label="Sign out"
          kind="danger"
          icon="log-out-outline"
          onPress={async () => { await signOut(); router.replace("/auth"); }}
        />
      </View>
    </Screen>
  );
}
