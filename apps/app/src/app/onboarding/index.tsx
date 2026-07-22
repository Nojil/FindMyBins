// Onboarding: legal attestations + first workspace, in one friendly screen.

import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { WorkspaceType } from "@findmybins/core";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { radius, spacing, useTheme } from "../../lib/theme";
import { Button, Card, Screen, Subtitle, TextField, Title } from "../../ui";

const TYPES: Array<{ value: WorkspaceType; label: string; hint: string; icon: string }> = [
  { value: "household", label: "Household", hint: "Home storage, seasonal bins, keepsakes", icon: "home-outline" },
  { value: "business", label: "Business", hint: "Supplies, equipment, location permissions", icon: "business-outline" },
  { value: "organization", label: "Organization", hint: "Teams, schools, churches, nonprofits", icon: "people-outline" },
];

export default function Onboarding() {
  const t = useTheme();
  const { profile, refresh } = useSession();
  const [adult, setAdult] = useState(profile?.is_18_or_over ?? false);
  const [terms, setTerms] = useState(!!profile?.terms_accepted_at);
  const [name, setName] = useState("");
  const [type, setType] = useState<WorkspaceType>("household");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!adult || !terms) {
      setError("Please confirm your age and accept the terms to continue.");
      return;
    }
    if (!name.trim()) {
      setError("Give your workspace a name — \"My Home\" works great.");
      return;
    }
    setBusy(true);
    try {
      await api.workspaces.updateProfile({ confirm_18_or_over: true, accept_terms: true });
      await api.workspaces.create(name.trim(), type);
      await refresh();
      router.replace("/");
    } catch {
      setError("Couldn't finish setup. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const CheckRow = ({ checked, onToggle, children }: {
    checked: boolean; onToggle: () => void; children: React.ReactNode;
  }) => (
    <Pressable
      onPress={onToggle}
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: spacing.sm }}
    >
      <Ionicons
        name={checked ? "checkbox" : "square-outline"}
        size={24}
        color={checked ? t.primary : t.textMuted}
      />
      <Text style={{ color: t.text, fontSize: 15, marginLeft: spacing.sm, flex: 1 }}>{children}</Text>
    </Pressable>
  );

  return (
    <Screen>
      <Title>Welcome to FindMyBins</Title>
      <Subtitle>A couple of quick things and you're organizing.</Subtitle>

      <CheckRow checked={adult} onToggle={() => setAdult(!adult)}>
        I confirm I am 18 or older
      </CheckRow>
      <CheckRow checked={terms} onToggle={() => setTerms(!terms)}>
        I accept the Terms of Service and Privacy Policy
      </CheckRow>

      <TextField
        label="Workspace name" value={name} onChangeText={setName}
        placeholder='e.g. "My Home" or "Shop Inventory"'
      />

      <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600", marginBottom: 6 }}>
        Workspace type
      </Text>
      {TYPES.map((opt) => (
        <Card
          key={opt.value}
          onPress={() => setType(opt.value)}
          style={{
            borderColor: type === opt.value ? t.primary : t.border,
            borderWidth: type === opt.value ? 2 : 1,
            borderRadius: radius.md,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name={opt.icon as any} size={22} color={type === opt.value ? t.primary : t.textMuted} />
            <View style={{ marginLeft: spacing.sm, flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{opt.label}</Text>
              <Text style={{ color: t.textMuted, fontSize: 13 }}>{opt.hint}</Text>
            </View>
            {type === opt.value ? <Ionicons name="checkmark-circle" size={22} color={t.primary} /> : null}
          </View>
        </Card>
      ))}

      {error ? <Text style={{ color: t.danger, marginVertical: spacing.sm }}>{error}</Text> : null}
      <View style={{ marginTop: spacing.md }}>
        <Button label="Create workspace" onPress={submit} loading={busy} />
      </View>
    </Screen>
  );
}
