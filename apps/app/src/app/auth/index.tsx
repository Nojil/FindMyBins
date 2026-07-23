// Sign-in: email/password plus Google and Apple OAuth.
// Web: full-page redirect through Base44's OAuth start, back to /auth/callback.
// Native: opens the provider in a browser tab that returns to an https relay
// page; that page stashes the token under an unguessable handoff id, and the
// app polls to claim it (see api/auth-handoff). No custom-scheme round trip,
// which is what kept breaking in Expo Go.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, Text, View } from "react-native";
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
  const handoffRef = useRef<string | null>(null);
  const claimedRef = useRef(false);

  const completeSignIn = useCallback(async () => {
    if (claimedRef.current) return;
    claimedRef.current = true;
    handoffRef.current = null;
    pollRef.current = false;
    await refresh();
    router.replace("/");
  }, [refresh]);

  // Backup trigger: whenever the app returns to the foreground during a pending
  // social sign-in, try to claim. This catches the case where closing the OAuth
  // tab doesn't cleanly resolve openAuthSessionAsync.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !handoffRef.current) return;
      (async () => {
        const id = handoffRef.current;
        if (!id) return;
        let result: "pending" | "ready" | "expired" = "pending";
        try { result = await api.auth.claimHandoff(id); } catch { return; }
        if (result === "ready") await completeSignIn();
      })();
    });
    return () => sub.remove();
  }, [completeSignIn]);

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
    claimedRef.current = false;
    const handoff = newHandoffId();
    handoffRef.current = handoff; // lets the AppState foreground-claim find it
    const relay = `${WEB_APP_URL}/native-auth.html?handoff=${handoff}`;

    // Claim the stored token, retrying to cover the moment right after the
    // relay's store call and any read-after-write lag.
    const claimToken = async (attempts: number): Promise<boolean> => {
      let last = "";
      for (let i = 0; i < attempts && pollRef.current; i++) {
        let result: "pending" | "ready" | "expired" = "pending";
        try { result = await api.auth.claimHandoff(handoff); }
        catch (e: any) { last = `error ${e?.status ?? "?"}`; }
        if (result === "ready") return true;
        if (result === "expired") { console.log("[oauth] handoff expired"); return false; }
        last = last || result;
        await new Promise((r) => setTimeout(r, 1500));
      }
      console.log(`[oauth] handoff never claimed (last: ${last})`);
      return false;
    };

    try {
      pollRef.current = true;
      const result = await WebBrowser.openAuthSessionAsync(
        api.auth.providerLoginUrl(provider, relay),
        relay,
      );
      // Diagnostic (visible in the Metro terminal) — tells us which path ran.
      console.log("[oauth] session result:", result.type,
        result.type === "success" ? `url has token: ${/access_token=/.test((result as any).url ?? "")}` : "");

      // Fast path: if the auth session resolved with the redirect URL, the
      // token is right there — adopt it directly, no relay/handoff needed.
      // (This is the common case when the browser hands the redirect back.)
      if (result.type === "success" && result.url) {
        const m = result.url.match(/[?&#]access_token=([^&#]+)/);
        if (m) {
          await api.auth.adoptToken(decodeURIComponent(m[1]));
          await completeSignIn();
          return;
        }
      }

      // Otherwise the relay stashed the token server-side. Poll to claim it —
      // AFTER the tab closed, since on Android the app is paused while the
      // Custom Tab is in front and a poll loop there wouldn't run.
      const claimed = await claimToken(20);
      if (claimed) {
        await completeSignIn();
        return;
      }
      // The AppState foreground handler may have claimed it in parallel.
      if (!claimedRef.current) {
        setError("Sign-in didn't complete. Please try again, or use email and password.");
      }
    } catch {
      if (!claimedRef.current) setError("Sign-in didn't complete. Please try again.");
    } finally {
      pollRef.current = false;
      handoffRef.current = null;
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
