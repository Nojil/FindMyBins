// More: workspace switcher, appearance, workspace tools, billing, account.

import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { spacing, useTheme, useThemeMode, type ThemeMode } from "../../lib/theme";
import {
  Badge, Button, Card, ListRow, Screen, SectionTitle, SegmentedControl, Subtitle, Title,
} from "../../ui";

const APPEARANCE_OPTIONS: Array<{ value: ThemeMode; label: string; icon: "phone-portrait-outline" | "sunny-outline" | "moon-outline" }> = [
  { value: "system", label: "System", icon: "phone-portrait-outline" },
  { value: "light", label: "Light", icon: "sunny-outline" },
  { value: "dark", label: "Dark", icon: "moon-outline" },
];

export default function More() {
  const t = useTheme();
  const { mode, resolved, setMode } = useThemeMode();
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

  const canBill = workspace?.my_role === "owner" || workspace?.my_role === "billing_admin";

  return (
    <Screen>
      <Title>More</Title>

      <SectionTitle>Appearance</SectionTitle>
      <SegmentedControl
        label="Appearance"
        options={APPEARANCE_OPTIONS}
        value={mode}
        onChange={setMode}
      />
      <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: spacing.sm }}>
        {mode === "system"
          ? `Following your device — currently ${resolved}.`
          : `Always ${mode}, on every device you sign in to.`}
      </Text>

      <SectionTitle>Workspaces</SectionTitle>
      {workspaces.map((w) => (
        <ListRow
          key={w.id}
          icon={w.workspace_type === "household" ? "home-outline" : "business-outline"}
          label={w.name}
          description={`${w.workspace_type} · ${w.my_role} · ${w.plan}`}
          selected={w.id === workspace?.id}
          onPress={() => selectWorkspace(w.id)}
        />
      ))}

      <SectionTitle>Workspace</SectionTitle>
      <ListRow
        icon="settings-outline"
        label="Settings, members & activity"
        onPress={() => router.push("/workspace-settings")}
      />
      <ListRow
        icon="trash-outline"
        label="Recently deleted"
        description="Restore items and files for 30 days"
        onPress={() => router.push("/recovery")}
      />
      <ListRow
        icon="print-outline"
        label="Print queue"
        description="Labels waiting to be printed"
        trailing={queueCount != null
          ? <Badge label={String(queueCount)} tone={queueCount > 0 ? "warn" : "neutral"} />
          : undefined}
      />

      {canBill && (
        <>
          <SectionTitle>Billing</SectionTitle>
          <ListRow
            icon="card-outline"
            label="Plan & billing"
            trailing={<Badge label={(workspace?.plan ?? "free").toUpperCase()} tone="accent" />}
            onPress={() => router.push("/billing")}
          />
        </>
      )}

      <SectionTitle>Account</SectionTitle>
      <Card>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>
          {profile?.display_name || "Your account"}
        </Text>
        <Subtitle>
          Search history is private to you and never visible to workspace admins.
        </Subtitle>
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
