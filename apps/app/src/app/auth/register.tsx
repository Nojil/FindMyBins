import React, { useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { api } from "../../lib/api";
import { spacing, useTheme } from "../../lib/theme";
import { Button, Screen, Subtitle, TextField, Title } from "../../ui";

export default function Register() {
  const t = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.auth.register(email.trim(), password);
      router.push({ pathname: "/auth/verify", params: { email: email.trim(), name: name.trim() } });
    } catch {
      setError("Couldn't create the account. The email may already be in use.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>Create your account</Title>
      <Subtitle>We'll email you a verification code.</Subtitle>
      <TextField label="Name" value={name} onChangeText={setName} placeholder="Your name" />
      <TextField
        label="Email" value={email} onChangeText={setEmail}
        autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com"
      />
      <TextField
        label="Password" value={password} onChangeText={setPassword}
        secureTextEntry placeholder="At least 8 characters"
      />
      {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
      <Button label="Continue" onPress={submit} loading={busy} disabled={!email || !password} />
      <Button label="Back to sign in" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
