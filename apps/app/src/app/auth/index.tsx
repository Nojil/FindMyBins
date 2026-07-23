// Sign-in: email/password plus Google and Apple OAuth.
// Web: full-page redirect through Base44's OAuth start, back to /auth/callback.
// Native: opens the provider in a browser tab that returns to an https relay
// page; that page stashes the token under an unguessable handoff id, and the
// app polls to claim it (see api/auth-handoff). No custom-scheme round trip,
// which is what kept breaking in Expo Go.

import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { Link, router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { Ionicons } from "@expo/vector-icons";
import { WEB_APP_URL, type OAuthProvider } from "@findmybins/core";
import { ApiError } from "@findmybins/api-client";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { elevation, radius, spacing, useTheme } from "../../lib/theme";
import { Button, Screen, Subtitle, TextField, Title } from "../../ui";

WebBrowser.maybeCompleteAuthSession();

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newHandoffId(): string {
  const bytes = Crypto.getRandomBytes(32);
  let out = "";
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

export default function SignIn() {
  const t = useTheme();
  const { signIn, refresh, status } = useSession();

  // If a session becomes valid while this screen is up, move on.
  useEffect(() => {
    if (status === "ready" || status === "onboarding") router.replace("/");
  }, [status]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [social, setSocial] = useState<OAuthProvider | null>(null);
  const pollRef = useRef(false);

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
    if (social) return;
    setError(null);
    if (Platform.OS === "web") {
      const from = `${window.location.origin}/auth/callback`;
      window.location.href = api.auth.providerLoginUrl(provider, from);
      return;
    }

    setSocial(provider);
    const handoff = newHandoffId();
    const relay = `${WEB_APP_URL}/native-auth.html?handoff=${handoff}`;

    try {
      // Open the provider; the browser returns to the relay page, which stores
      // the token server-side. We don't depend on the browser result at all —
      // we poll the handoff, which works even when the tab just closes.
      const opened = WebBrowser.openAuthSessionAsync(
        api.auth.providerLoginUrl(provider, relay),
        relay,
      );

      pollRef.current = true;
      const deadline = Date.now() + 150_000;
      let claimed = false;
      while (pollRef.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        let result: "pending" | "ready" | "expired" = "pending";
        try { result = await api.auth.claimHandoff(handoff); } catch { /* keep polling */ }
        if (result === "ready") { claimed = true; break; }
        if (result === "expired") break;
      }
      pollRef.current = false;
      try { WebBrowser.dismissAuthSession(); } catch { /* already closed */ }
      await opened.catch(() => undefined);

      if (claimed) {
        await refresh();
        router.replace("/");
        return;
      }
      setError("Sign-in didn't complete. Please try again, or use email and password.");
    } catch {
      setError("Sign-in didn't complete. Please try again.");
    } finally {
      pollRef.current = false;
      setSocial(null);
    }
  };

  useEffect(() => () => { pollRef.current = false; }, []);

  const SocialButton = ({ provider, icon, label }: {
    provider: OAuthProvider; icon: keyof typeof Ionicons.glyphMap; label: string;
  }) => {
    const active = social === provider;
    const waiting = social !== null && !active;
    return (
      <Pressable
        onPress={() => socialSignIn(provider)}
        disabled={social !== null}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: social !== null, busy: active }}
        style={({ pressed }) => [
          {
            minHeight: 50, borderRadius: radius.button, backgroundColor: t.card,
            alignItems: "center", justifyContent: "center", flexDirection: "row",
            marginVertical: spacing.xs,
          },
          elevation(t).card,
          waiting && { opacity: 0.5 },
          pressed && { opacity: 0.8 },
        ]}
      >
        {active ? (
          <ActivityIndicator color={t.text} style={{ marginRight: 8 }} />
        ) : (
          <Ionicons name={icon} size={19} color={t.text} style={{ marginRight: 8 }} />
        )}
        <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>
          {active ? "Waiting for sign-in…" : label}
        </Text>
      </Pressable>
    );
  };

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
