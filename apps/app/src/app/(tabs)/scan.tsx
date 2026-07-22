// Scan: camera QR scanning on iOS/Android, manual lookup everywhere.
// Scanned FindMyBins links route to /q/<token>; backend decides access.

import React, { useState } from "react";
import { Platform, Text, View } from "react-native";
import { router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { offlineContainerByQr, useSync } from "../../lib/offline";
import { elevation, radius, spacing, useTheme } from "../../lib/theme";
import { Button, EmptyState, Screen, Subtitle, TextField, Title } from "../../ui";

function extractToken(value: string): string | null {
  const match = value.match(/\/q\/([A-Za-z0-9]{10,64})/);
  return match ? match[1] : null;
}

export default function Scan() {
  const t = useTheme();
  const { workspace } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [handled, setHandled] = useState(false);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sync = useSync();

  const onScanned = (data: string) => {
    if (handled) return;
    const token = extractToken(data);
    if (!token) return;
    setHandled(true);
    setScanning(false);
    // Offline: resolve against the cached copy of authorized containers.
    if (!sync.online && workspace) {
      const cached = offlineContainerByQr(workspace.id, token);
      if (cached) {
        router.push(`/container/${cached.id}`);
      } else {
        setError("You're offline and this label isn't in your cached data.");
      }
      setTimeout(() => setHandled(false), 1500);
      return;
    }
    router.push(`/q/${token}`);
    setTimeout(() => setHandled(false), 1500);
  };

  const lookup = async () => {
    setError(null);
    const token = extractToken(manual);
    if (token) {
      router.push(`/q/${token}`);
      return;
    }
    const num = parseInt(manual.trim(), 10);
    if (!workspace || !Number.isInteger(num) || num < 1) {
      setError("Enter a container number (like 6) or paste a label link.");
      return;
    }
    try {
      const res = await api.containers.lookupByNumber(workspace.id, num);
      router.push(`/container/${res.container.id}`);
    } catch {
      setError("No container found or not accessible.");
    }
  };

  const nativeCamera = Platform.OS !== "web";

  return (
    <Screen scroll={!scanning}>
      <Title>Scan a label</Title>
      <Subtitle>Point the camera at a FindMyBins QR label.</Subtitle>

      {nativeCamera && scanning && permission?.granted && (
        <View style={{ borderRadius: radius.lg, overflow: "hidden", height: 360, marginBottom: spacing.md }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => onScanned(data)}
          />
        </View>
      )}

      {nativeCamera && !scanning && (
        <Button
          label="Open camera"
          icon="camera-outline"
          onPress={async () => {
            if (!permission?.granted) {
              const res = await requestPermission();
              if (!res.granted) return;
            }
            setScanning(true);
          }}
        />
      )}
      {nativeCamera && scanning && (
        <Button label="Stop scanning" kind="secondary" onPress={() => setScanning(false)} />
      )}

      {nativeCamera && permission && !permission.granted && !permission.canAskAgain && (
        <EmptyState
          icon="videocam-off-outline"
          title="Camera access is off"
          body="Enable camera access for FindMyBins in your device settings to scan labels."
        />
      )}

      {!nativeCamera && (
        <>
          {/* Web has no in-app camera: a placeholder holds the same space the
              live preview occupies on device, so the layout doesn't shift. */}
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel="Camera preview is unavailable on the web"
            style={[
              {
                height: 200, borderRadius: radius.lg, backgroundColor: t.elevated,
                alignItems: "center", justifyContent: "center", marginBottom: spacing.md,
              },
              elevation(t).card,
            ]}
          >
            <Ionicons name="qr-code-outline" size={34} color={t.textMuted} />
            <Text
              style={{
                fontFamily: Platform.select({ web: "ui-monospace, Menlo, monospace", default: "monospace" }),
                fontSize: 12, color: t.textMuted, letterSpacing: 1, marginTop: 10,
              }}
            >
              CAMERA PREVIEW
            </Text>
          </View>
          <Text style={{ color: t.textMuted, fontSize: 14, marginBottom: spacing.md }}>
            Use your phone's camera on a label, or look up a container below.
          </Text>
        </>
      )}

      <View style={{ marginTop: spacing.lg }}>
        <TextField
          label="Container number or label link"
          value={manual}
          onChangeText={setManual}
          placeholder="e.g. 6 or https://findmybins.com/q/…"
          autoCapitalize="none"
          onSubmitEditing={lookup}
        />
        {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
        <Button label="Look up" kind="secondary" onPress={lookup} disabled={!manual.trim()} />
      </View>
    </Screen>
  );
}
