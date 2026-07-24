// FindMyBins UI kit: friendly, rounded, high-contrast, large touch targets.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Keyboard, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { elevation, radius, spacing, useTheme } from "../lib/theme";

export function Screen({ children, scroll = true, padded = true, style }: {
  children: React.ReactNode; scroll?: boolean; padded?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const offsetY = useRef(0);
  const [kbPad, setKbPad] = useState(0);
  const inner = [
    padded && { padding: spacing.md, paddingBottom: spacing.xl },
    { maxWidth: 720, width: "100%" as const, alignSelf: "center" as const },
    style,
  ];
  // Vertical top-to-bottom gradient is the base surface for every screen.
  const gradient = (
    <LinearGradient colors={[...t.bgGradient]} style={StyleSheet.absoluteFill} />
  );

  // Keep the focused input above the keyboard. React Native's ScrollView does
  // NOT do this on its own, and in Expo Go the keyboard overlays the app without
  // resizing the window — so a form that fits on screen has no room to scroll
  // and the field stays hidden. Two steps, both required: (1) add bottom padding
  // equal to the keyboard height so the content becomes scrollable, then (2)
  // measure the focused field and scroll it above the keyboard's top edge. This
  // is dependency-free (works in Expo Go) and is correct whether or not the OS
  // resizes the window.
  useEffect(() => {
    if (!scroll || Platform.OS === "web") return;
    const onShow = (e: any) => {
      setKbPad(e?.endCoordinates?.height ?? 0);
      const keyboardTop = e?.endCoordinates?.screenY ?? Number.MAX_SAFE_INTEGER;
      const input: any = TextInput.State.currentlyFocusedInput?.();
      if (!input?.measureInWindow || !scrollRef.current) return;
      // Wait for the new bottom padding to lay out before scrolling, or there's
      // still nothing to scroll into.
      setTimeout(() => {
        input.measureInWindow((_x: number, y: number, _w: number, h: number) => {
          const overlap = y + h + spacing.md - keyboardTop;
          if (overlap > 0) scrollRef.current?.scrollTo({ y: offsetY.current + overlap, animated: true });
        });
      }, 60);
    };
    const showSub = Keyboard.addListener("keyboardDidShow", onShow);
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKbPad(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [scroll]);

  if (!scroll) {
    return (
      <View style={[styles.fill, { backgroundColor: t.bg, paddingTop: insets.top }]}>
        {gradient}
        <View style={[styles.fill, ...inner]}>{children}</View>
      </View>
    );
  }
  return (
    <View style={[styles.fill, { backgroundColor: t.bg }]}>
      {gradient}
      <ScrollView
        ref={scrollRef}
        style={styles.fill}
        contentContainerStyle={[
          { paddingTop: insets.top, flexGrow: 1 },
          ...inner,
          { paddingBottom: (padded ? spacing.xl : 0) + kbPad },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onScroll={(e) => { offsetY.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
      >
        {children}
      </ScrollView>
    </View>
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
  // Elevation replaces the outline: solid fill + layered shadow.
  const base = [styles.card, { backgroundColor: t.card }, elevation(t).card, style];
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
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!loading }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor, borderWidth: kind === "secondary" ? 1.5 : 0 },
        // Solid fill plus a coloured glow gives the primary action its lift;
        // outlined/ghost buttons stay flat against the card surface.
        kind === "primary" && elevation(t).primary,
        kind === "secondary" && [{ backgroundColor: t.card }, elevation(t).chip],
        (disabled || loading) && { opacity: 0.5, shadowOpacity: 0 },
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
          { backgroundColor: t.inputBg, color: t.text },
          elevation(t).card,
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
  // Theme tokens rather than fixed hex, so warnings stay legible on dark cards.
  const bg = tone === "accent" ? `${t.accent}22` : tone === "warn" ? `${t.warning}26` : `${t.textMuted}1A`;
  const fg = tone === "accent" ? t.accent : tone === "warn" ? t.warning : t.textMuted;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/**
 * Standard settings/navigation row: icon, label, optional value or trailing
 * node, and a chevron when it navigates. Replaces the card+row boilerplate
 * that was repeated across the settings screens.
 */
export function ListRow({ icon, label, description, value, trailing, onPress, selected, tone = "accent", last }: {
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  selected?: boolean;
  tone?: "accent" | "muted" | "danger";
  last?: boolean;
}) {
  const t = useTheme();
  const iconColor = tone === "danger" ? t.danger : tone === "muted" ? t.textMuted : t.accent;
  const body = (
    <View style={styles.row}>
      {icon ? <Ionicons name={icon} size={20} color={selected ? t.primary : iconColor} /> : null}
      <View style={{ flex: 1, marginLeft: icon ? spacing.sm : 0 }}>
        <Text style={{ color: tone === "danger" ? t.danger : t.text, fontSize: 15, fontWeight: "600" }}>
          {label}
        </Text>
        {description ? (
          <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }}>{description}</Text>
        ) : null}
      </View>
      {value ? <Text style={{ color: t.textMuted, fontSize: 14, marginRight: 6 }}>{value}</Text> : null}
      {trailing}
      {selected ? <Ionicons name="checkmark-circle" size={20} color={t.primary} /> : null}
      {onPress && !selected ? (
        <Ionicons name="chevron-forward" size={18} color={t.textMuted} style={{ marginLeft: 6 }} />
      ) : null}
    </View>
  );
  const frame: StyleProp<ViewStyle> = [
    styles.listRow,
    { backgroundColor: t.card },
    elevation(t).card,
    last === false && { marginBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  ];
  if (!onPress) return <View style={frame}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [frame, pressed && { opacity: 0.85 }]}
    >
      {body}
    </Pressable>
  );
}

/** Accessible segmented picker — used for the appearance and interval choices. */
export function SegmentedControl<T extends string>({ options, value, onChange, label }: {
  options: Array<{ value: T; label: string; icon?: keyof typeof Ionicons.glyphMap }>;
  value: T;
  onChange: (value: T) => void;
  label?: string;
}) {
  const t = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <View style={[styles.segment, { backgroundColor: t.elevated }]}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.label}
              style={({ pressed }) => [
                styles.segmentItem,
                active && { backgroundColor: t.card, borderColor: t.primary, borderWidth: 1.5 },
                pressed && { opacity: 0.85 },
              ]}
            >
              {opt.icon ? (
                <Ionicons
                  name={opt.icon}
                  size={16}
                  color={active ? t.primary : t.textMuted}
                  style={{ marginRight: 6 }}
                />
              ) : null}
              <Text style={{ color: active ? t.primary : t.textMuted, fontWeight: "600", fontSize: 14 }}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
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
  const color = conflictCount > 0 ? t.warning : !online ? t.textMuted : t.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={`Sync status: ${label}`}
      style={[
        {
          flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
          backgroundColor: t.card, borderRadius: 999,
          paddingHorizontal: 12, paddingVertical: 7, marginBottom: spacing.sm,
        },
        elevation(t).chip,
      ]}
    >
      {/* Status dot carries the colour; the icon + text keep it non-colour-only. */}
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, marginRight: 7 }} />
      <Ionicons name={icon} size={13} color={color} />
      <Text style={{ color, fontSize: 13, fontWeight: "600", marginLeft: 5 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: spacing.xs },
  subtitle: { fontSize: 15, marginBottom: spacing.md },
  section: { fontSize: 17, fontWeight: "700", marginTop: spacing.lg, marginBottom: spacing.sm },
  card: { borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  button: {
    minHeight: 50, borderRadius: radius.button, alignItems: "center", justifyContent: "center",
    paddingHorizontal: spacing.lg, marginVertical: spacing.xs,
  },
  buttonRow: { flexDirection: "row", alignItems: "center" },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  fieldLabel: { fontSize: 13, fontWeight: "600", marginBottom: 6 },
  input: { borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16 },
  empty: { alignItems: "center", paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  emptyTitle: { fontSize: 17, fontWeight: "700", marginTop: spacing.sm, textAlign: "center" },
  emptyBody: { fontSize: 14, marginTop: 6, textAlign: "center", lineHeight: 20 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" },
  row: { flexDirection: "row", alignItems: "center", minHeight: 28 },
  listRow: { borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.sm },
  segment: { flexDirection: "row", borderRadius: radius.md, padding: 4, gap: 4, marginBottom: spacing.sm },
  segmentItem: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1.5, borderColor: "transparent",
    minHeight: 44,
  },
});
