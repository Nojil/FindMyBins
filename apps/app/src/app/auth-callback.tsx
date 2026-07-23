// Landing route for the native OAuth deep link
// (findmybins://auth-callback, exp://…/--/auth-callback in Expo Go).
//
// The token itself is adopted by SessionProvider's deep-link handler, which
// sees the URL regardless of routing timing. This screen only waits for the
// session to settle and then sends the user on — it deliberately does not read
// the token from route params, because on a cold start those are frequently
// empty on first render, which used to drop the token and bounce back to
// sign-in.

import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { useSession } from "../lib/session";
import { spacing, useTheme } from "../lib/theme";
import { Button, LoadingView, Screen, Subtitle, Title } from "../ui";

const TIMEOUT_MS = 12000;

export default function NativeAuthCallback() {
  const t = useTheme();
  const { status } = useSession();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (status === "ready" || status === "onboarding") {
      router.replace("/");
    }
  }, [status]);

  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  if (timedOut && status === "signedOut") {
    return (
      <Screen>
        <Title>Sign-in didn't complete</Title>
        <Subtitle>We didn't receive a valid session. Please try again.</Subtitle>
        <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.md }}>
          If this keeps happening, sign in with your email and password instead.
        </Text>
        <Button label="Back to sign in" onPress={() => router.replace("/auth")} />
      </Screen>
    );
  }

  return <LoadingView />;
}
