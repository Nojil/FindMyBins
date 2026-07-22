// QR resolution route — the universal-link and web target for label scans.
// Preserves the destination through login; shows generic denial otherwise.

import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { QrResolution } from "@findmybins/core";
import { ApiError } from "@findmybins/api-client";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { radius, spacing, useTheme } from "../../lib/theme";
import { Button, Card, EmptyState, LoadingView, Screen, SectionTitle } from "../../ui";

export default function QrRoute() {
  const t = useTheme();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { status } = useSession();
  const [result, setResult] = useState<QrResolution | null>(null);
  const [state, setState] = useState<"loading" | "denied" | "ok">("loading");

  const resolve = useCallback(async () => {
    try {
      const res = await api.qr.resolve(String(token));
      setResult(res);
      setState("ok");
    } catch (err) {
      setState(err instanceof ApiError && err.status === 401 ? "loading" : "denied");
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/auth");
      }
    }
  }, [token]);

  useEffect(() => {
    if (status === "signedOut") return; // Redirect below keeps /q/<token> as the return target.
    if (status === "ready" || status === "onboarding") resolve();
  }, [status, resolve]);

  if (status === "signedOut") return <Redirect href="/auth" />;
  if (state === "loading") return <LoadingView />;

  if (state === "denied" || !result) {
    return (
      <Screen>
        <EmptyState
          icon="lock-closed-outline"
          title="Not found or not accessible"
          body="This label doesn't lead anywhere you can go. Check with the workspace admin if you think it should."
          action={<Button label="Go home" onPress={() => router.replace("/")} />}
        />
      </Screen>
    );
  }

  const c = result.container;

  return (
    <Screen>
      <View style={{ alignItems: "center", marginVertical: spacing.lg }}>
        <View
          style={{
            backgroundColor: `${t.primary}18`, borderRadius: radius.md,
            paddingHorizontal: 18, paddingVertical: 10,
          }}
        >
          <Text style={{ color: t.primary, fontSize: 24, fontWeight: "700" }}>
            {c.number_display ?? "—"}
          </Text>
        </View>
        <Text style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: spacing.sm }}>{c.title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
          <Ionicons name="location-outline" size={15} color={t.accent} />
          <Text style={{ color: t.textMuted, fontSize: 14, marginLeft: 4 }}>{c.location_path}</Text>
        </View>
        <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>{result.workspace.name}</Text>
      </View>

      {result.state === "archived" ? (
        <EmptyState
          icon="archive-outline"
          title="This container is archived"
          body="Its number and label stay reserved. Restore it to keep using it."
          action={result.can_restore
            ? <Button label="Open to restore" onPress={() => router.replace(`/container/${c.id}`)} />
            : undefined}
        />
      ) : (
        <>
          <Button label="Open container" onPress={() => router.replace(`/container/${c.id}`)} />
          <SectionTitle>Inside ({result.items?.length ?? 0})</SectionTitle>
          {(result.items ?? []).map((i) => (
            <Card key={i.id}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{i.name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 13 }}>
                {i.quantity != null ? `Quantity: ${i.quantity}` : "Quantity not specified"}
              </Text>
            </Card>
          ))}
          {(result.items ?? []).length === 0 && (
            <Text style={{ color: t.textMuted }}>No items listed yet.</Text>
          )}
        </>
      )}
    </Screen>
  );
}
