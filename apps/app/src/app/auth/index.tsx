// Sign-in: email/password plus Google and Apple OAuth.
// Web: full-page redirect through Base44's OAuth start, back to /auth/callback.
// Native: auth-session browser; the callback page forwards the token to the
// app scheme, closing the session.

import React, { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Link, router } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { WEB_APP_URL, type OAuthProvider } from "@findmybins/core";
import { ApiError } from "@findmybins/api-client";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { elevation, radius, spacing, useTheme } from "../../lib/theme";
import { Button, Screen, Subtitle, TextField, Title } from "../../ui";

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const t = useTheme();
  const { signIn, refresh, status } = useSession();

  // A deep-link token can be adopted while this screen is showing (the app
  // resumed rather than cold-started). Move on as soon as that happens.
  useEffect(() => {
    if (status === "ready" || status === "onboarding") router.replace("/");
  }, [status]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401
        ? "That email and password don't match."
        : "Couldn't sign in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const socialSignIn = async (provider: OAuthProvider) => {
    setError(null);
    if (Platform.OS === "web") {
      const from = `${window.location.origin}/auth/callback`;
      window.location.href = api.auth.providerLoginUrl(provider, from);
      return;
    }
    try {
      // Base44 validates the redirect domain at its callback step and rejects
      // custom schemes, so the app can't be the redirect target directly. It
      // returns to a tiny static relay page on our https domain, which hands
      // the token to this app's scheme (see public/native-auth.html).
      const redirectUri = Linking.createURL("auth-callback");
      const relay = `${WEB_APP_URL}/native-auth.html?return_to=${encodeURIComponent(redirectUri)}`;
      const result = await WebBrowser.openAuthSessionAsync(
        api.auth.providerLoginUrl(provider, relay),
        redirectUri,
      );
      if (result.type === "success" && result.url) {
        // The token may arrive as a query param or a fragment.
        const match = result.url.match(/[?&#]access_token=([^&#]+)/);
        const token = match ? decodeURIComponent(match[1]) : null;
        if (token) {
          await api.auth.adoptToken(token);
          await refresh();
          router.replace("/");
          return;
        }
        setError("Signed in, but no token came back. Please try again.");
        return;
      }
      if (result.type !== "cancel" && result.type !== "dismiss") {
        setError("Sign-in didn't complete. Please try again.");
      }
    } catch {
      setError("Sign-in didn't complete. Please try again.");
    }
  };

  const SocialButton = ({ provider, icon, label }: {
    provider: OAuthProvider; icon: keyof typeof Ionicons.glyphMap; label: string;
  }) => (
    <Pressable
      onPress={() => socialSignIn(provider)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          minHeight: 50, borderRadius: radius.button, backgroundColor: t.card,
          alignItems: "center", justifyContent: "center", flexDirection: "row",
          marginVertical: spacing.xs,
        },
        elevation(t).card,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Ionicons name={icon} size={19} color={t.text} style={{ marginRight: 8 }} />
      <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );

  return (
    <Screen>
      <View style={{ marginTop: spacing.xl }}>
        <Title>FindMyBins</Title>
        <Subtitle>Scan It. Store It. Find It.</Subtitle>
      </View>

      <SocialButton provider="google" icon="logo-google" label="Continue with Google" />
      <SocialButton provider="apple" icon="logo-apple" label="Continue with Apple" />

      <View style={{ flexDirection: "row", alignItems: "center", marginVertical: spacing.md }}>
        <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
        <Text style={{ color: t.textMuted, fontSize: 13, marginHorizontal: spacing.sm }}>
          or with email
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
      </View>

      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        placeholder="you@example.com"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="••••••••"
        onSubmitEditing={submit}
      />
      {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
      <Button label="Sign in" onPress={submit} loading={busy} disabled={!email || !password} />
      <View style={{ alignItems: "center", marginTop: spacing.md }}>
        <Link href="/auth/register" style={{ color: t.primary, fontSize: 15, fontWeight: "600" }}>
          New here? Create an account
        </Link>
      </View>
    </Screen>
  );
}
