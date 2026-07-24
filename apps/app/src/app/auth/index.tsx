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
  // On-screen trace of the native OAuth steps, so a failure is legible on the
  // device without watching the Metro terminal. Lines are also persisted (via
  // noteOAuth) so the trace survives Expo Go reloading the bundle on return from
  // the browser — and so the headless resume in SessionProvider shows up here.
  const [trace, setTrace] = useState<string[]>([]);
  const log = (line: string) => {
    setTrace((prev) => [...prev.slice(-6), line]);
    void api.auth.noteOAuth(line);
  };

  // After a reload mid-sign-in, replay whatever the persisted log holds so the
  // login screen shows what happened (including the SessionProvider resume).
  useEffect(() => {
    (async () => {
      const persisted = await api.auth.readOAuthLog();
      if (persisted.length) setTrace(persisted.slice(-7));
    })();
  }, []);
  const pollRef = useRef(false);
  const handoffRef = useRef<string | null>(null);
  const claimedRef = useRef(false);

  const completeSignIn = useCallback(async () => {
    if (claimedRef.current) return;
    claimedRef.current = true;
    handoffRef.current = null;
    pollRef.current = false;
    await api.auth.clearPendingHandoff();
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
    setTrace([]);
    await api.auth.clearOAuthLog();
    claimedRef.current = false;
    const handoff = newHandoffId();
    handoffRef.current = handoff; // lets the AppState foreground-claim find it
    // Persist so the claim can resume if the app reloads on return (Expo Go).
    await api.auth.savePendingHandoff(handoff);
    const relay = `${WEB_APP_URL}/native-auth.html?handoff=${handoff}`;

    const claimToken = async (attempts: number): Promise<boolean> => {
      let last = "";
      for (let i = 0; i < attempts && pollRef.current; i++) {
        let result: "pending" | "ready" | "expired" = "pending";
        try { result = await api.auth.claimHandoff(handoff); }
        catch (e: any) { last = `err ${e?.status ?? e?.message ?? "?"}`.slice(0, 40); }
        if (result === "ready") return true;
        if (result === "expired") { log("handoff: expired"); return false; }
        last = last || result;
        if (i === 2) log(`claiming… (${last})`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      log(`handoff never claimed (last: ${last})`);
      return false;
    };

    try {
      pollRef.current = true;
      log("opening provider…");
      const result = await WebBrowser.openAuthSessionAsync(
        api.auth.providerLoginUrl(provider, relay),
        relay,
      );
      const url = (result as any).url as string | undefined;
      log(`returned: ${result.type}${url ? `, token in url: ${/access_token=/.test(url)}` : ""}`);

      // Fast path: the auth session handed us the redirect URL with the token.
      if (result.type === "success" && url) {
        const m = url.match(/[?&#]access_token=([^&#\s]+)/);
        if (m) {
          log("adopting token from url");
          await api.auth.adoptToken(decodeURIComponent(m[1]));
          await completeSignIn();
          return;
        }
      }

      // Otherwise the relay stored it server-side; poll to claim.
      const claimed = await claimToken(20);
      if (claimed) { await completeSignIn(); return; }
      if (!claimedRef.current) {
        setError("Sign-in didn't complete. Please try again, or use email and password.");
      }
    } catch (e: any) {
      log(`error: ${String(e?.message ?? e).slice(0, 80)}`);
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

      {trace.length > 0 && (
        <View
          style={{
            backgroundColor: t.elevated, borderRadius: radius.md,
            padding: spacing.sm, marginTop: spacing.xs,
          }}
        >
          {trace.map((line, i) => (
            <Text key={i} style={{ color: t.textMuted, fontSize: 12, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) }}>
              {line}
            </Text>
          ))}
        </View>
      )}

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
