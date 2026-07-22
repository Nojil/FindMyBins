// Billing screen. Web upgrades go through Stripe Checkout (a redirect); native
// upgrades go through store IAP. Both providers are implemented but dormant
// until credentials are wired — the UI shows a "coming soon" state and never
// dead-ends. Trials need no payment method.

import React, { useCallback, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { formatBytes } from "@findmybins/core";
import type { BillingSnapshot } from "@findmybins/api-client";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { radius, spacing, useTheme } from "../lib/theme";
import { Badge, Button, Card, ErrorView, LoadingView, Screen, SectionTitle, Subtitle, Title } from "../ui";

export default function Billing() {
  const t = useTheme();
  const { workspace, refresh } = useSession();
  const [data, setData] = useState<BillingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setIntervalChoice] = useState<"monthly" | "annual">("monthly");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setError(null);
      setData(await api.billing.get(workspace.id));
    } catch (e: any) {
      setError(e?.status === 403 ? "Only the owner or billing admin can manage billing." : "Couldn't load billing.");
    }
  }, [workspace?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!workspace || !data) return <LoadingView />;

  const targetPlan = workspace.workspace_type === "household" ? "household" : "business";
  const price = data.pricing[targetPlan];
  const priceLabel = interval === "monthly"
    ? `$${price.monthly_usd}/mo`
    : `$${price.annual_usd}/yr`;

  const startTrial = async () => {
    setBusy(true); setNote(null);
    try {
      await api.workspacesExtra.startTrial(workspace.id);
      await refresh();
      await load();
      setNote("Your 14-day trial is active. Enjoy!");
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't start the trial.");
    } finally { setBusy(false); }
  };

  const upgrade = async () => {
    setBusy(true); setNote(null);
    try {
      if (Platform.OS === "web") {
        const res = await api.billing.startCheckout(workspace.id, targetPlan, interval);
        if (res.configured && res.checkout_url) { await Linking.openURL(res.checkout_url); return; }
        setNote(res.message ?? "Payments aren't set up yet.");
      } else {
        // Native: hand off to store IAP. Purchase UI + receipt submission wire
        // up when store products exist; until then, show the pending state.
        const productId = `com.six47.findmybins.${targetPlan}.${interval}`;
        const res = await api.billing.applyIapReceipt(workspace.id, Platform.OS as "ios" | "android", productId, "");
        setNote(res.configured ? "Purchase started." : (res.message ?? "In-app purchases aren't set up yet."));
      }
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't start the upgrade.");
    } finally { setBusy(false); }
  };

  const manage = async () => {
    setBusy(true); setNote(null);
    try {
      const res = await api.billing.openPortal(workspace.id);
      if (res.configured && res.portal_url) { await Linking.openURL(res.portal_url); return; }
      setNote(res.message ?? "Payments aren't set up yet.");
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't open billing management.");
    } finally { setBusy(false); }
  };

  const storagePct = Math.min(100, Math.round((data.storage.bytes_used / data.storage.bytes_limit) * 100));
  const isPaid = data.plan !== "free";
  const onTrial = data.status === "trialing";

  return (
    <Screen>
      <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
        <Ionicons name="arrow-back" size={24} color={t.textMuted} />
      </Pressable>
      <Title>Plan & billing</Title>

      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: "700" }}>{data.plan.toUpperCase()}</Text>
            <Text style={{ color: t.textMuted, fontSize: 13 }}>
              {onTrial ? `Trial ends ${new Date(data.trial_ends_at!).toLocaleDateString()}`
                : data.status === "past_due" ? "Payment past due"
                : isPaid ? `Renews ${data.current_period_end ? new Date(data.current_period_end).toLocaleDateString() : "—"}`
                : "No charge"}
            </Text>
          </View>
          {onTrial && <Badge label="TRIAL" tone="accent" />}
          {data.status === "past_due" && <Badge label="PAST DUE" tone="warn" />}
        </View>
        {data.seats && (
          <Text style={{ color: t.textMuted, fontSize: 13, marginTop: spacing.sm }}>
            Seats: {data.seats.included} included{data.seats.extra > 0 ? ` + ${data.seats.extra} extra` : ""}
          </Text>
        )}
      </Card>

      <Card>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: "600" }}>Storage</Text>
        <View style={{ height: 8, backgroundColor: t.border, borderRadius: 4, marginVertical: 8, overflow: "hidden" }}>
          <View style={{ width: `${storagePct}%`, height: 8, backgroundColor: storagePct >= 90 ? t.danger : t.accent }} />
        </View>
        <Text style={{ color: t.textMuted, fontSize: 12 }}>
          {formatBytes(data.storage.bytes_used)} of {formatBytes(data.storage.bytes_limit)} ({storagePct}%)
        </Text>
      </Card>

      {data.ai_trial && (
        <Card>
          <Text style={{ color: t.textMuted, fontSize: 13 }}>
            AI trial: {data.ai_trial.used} of {data.ai_trial.total} actions used
          </Text>
        </Card>
      )}

      {!isPaid && (
        <>
          <SectionTitle>Upgrade to {targetPlan}</SectionTitle>
          <Subtitle>Unlimited containers, AI assistance, CSV import, and more.</Subtitle>

          <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
            {(["monthly", "annual"] as const).map((opt) => (
              <Pressable
                key={opt}
                onPress={() => setIntervalChoice(opt)}
                style={{
                  flex: 1, padding: spacing.md, borderRadius: radius.md, alignItems: "center",
                  borderWidth: interval === opt ? 2 : 1, borderColor: interval === opt ? t.primary : t.border,
                  backgroundColor: t.card,
                }}
              >
                <Text style={{ color: t.text, fontWeight: "700", fontSize: 16 }}>
                  ${opt === "monthly" ? price.monthly_usd : price.annual_usd}
                </Text>
                <Text style={{ color: t.textMuted, fontSize: 12 }}>{opt === "monthly" ? "per month" : "per year"}</Text>
                {opt === "annual" && <Badge label="Save" tone="accent" />}
              </Pressable>
            ))}
          </View>

          <Button label={`Upgrade — ${priceLabel}`} icon="rocket-outline" onPress={upgrade} loading={busy} />
          {data.stored_plan === "free" && !onTrial && (
            <Button label="Start 14-day free trial" kind="secondary" onPress={startTrial} loading={busy} />
          )}
        </>
      )}

      {isPaid && (
        <>
          <SectionTitle>Manage</SectionTitle>
          <Button label="Manage subscription" icon="card-outline" onPress={manage} loading={busy} />
          <Text style={{ color: t.textMuted, fontSize: 12, marginTop: spacing.xs }}>
            Update your card, change seats, or cancel. Canceling keeps all your data — you just return to Free.
          </Text>
        </>
      )}

      {note && (
        <Card style={{ marginTop: spacing.md }}>
          <Text style={{ color: t.text, fontSize: 14 }}>{note}</Text>
        </Card>
      )}

      <Text style={{ color: t.textMuted, fontSize: 11, marginTop: spacing.lg, textAlign: "center" }}>
        Downgrades never delete inventory. Your records stay searchable and exportable.
      </Text>
    </Screen>
  );
}
