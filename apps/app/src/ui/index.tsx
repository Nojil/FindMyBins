// FindMyBins UI kit: friendly, rounded, high-contrast, large touch targets.

import React from "react";
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { radius, spacing, useTheme } from "../lib/theme";

export function Screen({ children, scroll = true, padded = true, style }: {
  children: React.ReactNode; scroll?: boolean; padded?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const inner = [
    padded && { padding: spacing.md, paddingBottom: spacing.xl },
    { maxWidth: 720, width: "100%" as const, alignSelf: "center" as const },
    style,
  ];
  if (!scroll) {
    return (
      <View style={[styles.fill, { backgroundColor: t.bg, paddingTop: insets.top }]}>
        <View style={[styles.fill, ...inner]}>{children}</View>
      </View>
    );
  }
  return (
    <ScrollView
      style={[styles.fill, { backgroundColor: t.bg }]}
      contentContainerStyle={[{ paddingTop: insets.top }, ...inner]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.text }]}>{children}</Text>;
}

export function Subtitle({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.subtitle, { color: t.textMuted }]}>{children}</Text>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.section, { color: t.text }]}>{children}</Text>;
}

export function Card({ children, style, onPress }: {
  children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void;
}) {
  const t = useTheme();
  const base = [styles.card, { backgroundColor: t.card, borderColor: t.border }, style];
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [...base, pressed && { opacity: 0.85 }]}>
        {children}
      </Pressable>
    );
  }
  return <View style={base}>{children}</View>;
}

export function Button({ label, onPress, kind = "primary", disabled, loading, icon }: {
  label: string; onPress: () => void; kind?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean; loading?: boolean; icon?: keyof typeof Ionicons.glyphMap;
}) {
  const t = useTheme();
  const bg = kind === "primary" ? t.primary : kind === "danger" ? t.danger : "transparent";
  const fg = kind === "primary" || kind === "danger" ? t.primaryText : kind === "ghost" ? t.textMuted : t.primary;
  const borderColor = kind === "secondary" ? t.primary : "transparent";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor, borderWidth: kind === "secondary" ? 1.5 : 0 },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {loading
        ? <ActivityIndicator color={fg} />
        : (
          <View style={styles.buttonRow}>
            {icon ? <Ionicons name={icon} size={18} color={fg} style={{ marginRight: 6 }} /> : null}
            <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
          </View>
        )}
    </Pressable>
  );
}

export function TextField(props: TextInputProps & { label?: string }) {
  const t = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={[styles.fieldLabel, { color: t.textMuted }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={t.textMuted}
        style={[
          styles.input,
          { backgroundColor: t.inputBg, borderColor: t.border, color: t.text },
          rest.multiline && { minHeight: 96, textAlignVertical: "top" },
          style,
        ]}
        {...rest}
      />
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: {
  icon: keyof typeof Ionicons.glyphMap; title: string; body?: string; action?: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={44} color={t.textMuted} />
      <Text style={[styles.emptyTitle, { color: t.text }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: t.textMuted }]}>{body}</Text> : null}
      {action ? <View style={{ marginTop: spacing.md }}>{action}</View> : null}
    </View>
  );
}

export function LoadingView() {
  const t = useTheme();
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
      <ActivityIndicator size="large" color={t.primary} />
    </View>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTheme();
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: t.bg, padding: spacing.lg }]}>
      <Ionicons name="cloud-offline-outline" size={44} color={t.textMuted} />
      <Text style={[styles.emptyTitle, { color: t.text }]}>Something went wrong</Text>
      <Text style={[styles.emptyBody, { color: t.textMuted }]}>{message}</Text>
      {onRetry ? <View style={{ marginTop: spacing.md }}><Button label="Try again" onPress={onRetry} /></View> : null}
    </View>
  );
}

export function Badge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "accent" | "warn" }) {
  const t = useTheme();
  const bg = tone === "accent" ? `${t.accent}22` : tone === "warn" ? "#F59E0B22" : `${t.textMuted}1A`;
  const fg = tone === "accent" ? t.accent : tone === "warn" ? "#B45309" : t.textMuted;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function SyncPill({ online, syncing, pendingCount, conflictCount, onPress }: {
  online: boolean; syncing: boolean; pendingCount: number; conflictCount: number; onPress?: () => void;
}) {
  const t = useTheme();
  const label = conflictCount > 0 ? `Needs attention (${conflictCount})`
    : syncing ? "Syncing…"
    : !online ? (pendingCount > 0 ? `Offline · ${pendingCount} saved locally` : "Offline")
    : pendingCount > 0 ? `Waiting to sync (${pendingCount})`
    : "Synced";
  const icon: keyof typeof Ionicons.glyphMap = conflictCount > 0 ? "alert-circle"
    : syncing ? "sync"
    : !online ? "cloud-offline-outline"
    : pendingCount > 0 ? "cloud-upload-outline"
    : "cloud-done-outline";
  const color = conflictCount > 0 ? "#B45309" : !online ? t.textMuted : t.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
        backgroundColor: `${color}18`, borderRadius: 999,
        paddingHorizontal: 12, paddingVertical: 6, marginBottom: spacing.sm,
      }}
    >
      <Ionicons name={icon} size={14} color={color} />
      <Text style={{ color, fontSize: 13, fontWeight: "600", marginLeft: 6 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: spacing.xs },
  subtitle: { fontSize: 15, marginBottom: spacing.md },
  section: { fontSize: 17, fontWeight: "700", marginTop: spacing.lg, marginBottom: spacing.sm },
  card: {
    borderRadius: radius.md, borderWidth: 1, padding: spacing.md, marginBottom: spacing.sm,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  button: {
    minHeight: 48, borderRadius: radius.lg, alignItems: "center", justifyContent: "center",
    paddingHorizontal: spacing.lg, marginVertical: spacing.xs,
  },
  buttonRow: { flexDirection: "row", alignItems: "center" },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  fieldLabel: { fontSize: 13, fontWeight: "600", marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  empty: { alignItems: "center", paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  emptyTitle: { fontSize: 17, fontWeight: "700", marginTop: spacing.sm, textAlign: "center" },
  emptyBody: { fontSize: 14, marginTop: 6, textAlign: "center", lineHeight: 20 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" },
});
