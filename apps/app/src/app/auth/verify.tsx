import React, { useState } from "react";
import { Text } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { spacing, useTheme } from "../../lib/theme";
import { Button, Screen, Subtitle, TextField, Title } from "../../ui";

export default function Verify() {
  const t = useTheme();
  const { refresh } = useSession();
  const { email, name } = useLocalSearchParams<{ email: string; name?: string }>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.auth.verifyOtp(String(email), code.trim());
      if (name) await api.workspaces.updateProfile({ display_name: String(name) }).catch(() => {});
      await refresh();
      router.replace("/");
    } catch {
      setError("That code didn't work. It may have expired.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>Check your email</Title>
      <Subtitle>Enter the 6-digit code we sent to {email}.</Subtitle>
      <TextField
        label="Verification code" value={code} onChangeText={setCode}
        keyboardType="number-pad" placeholder="123456" maxLength={6}
      />
      {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
      <Button label="Verify" onPress={submit} loading={busy} disabled={code.length < 6} />
      <Button
        label="Resend code" kind="ghost"
        onPress={() => api.auth.resendOtp(String(email)).catch(() => {})}
      />
    </Screen>
  );
}
