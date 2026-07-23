// Landing route for a native OAuth deep link (findmybins://auth-callback, or
// exp://…/--/auth-callback in Expo Go). The token itself is adopted by
// SessionProvider's deep-link handler; this screen only waits for the session
// to settle and moves on. It exists so the deep link is never "Unmatched," and
// it never reads the token from route params (empty on cold start).

import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { useSession } from "../lib/session";
import { spacing, useTheme } from "../lib/theme";
import { Button, LoadingView, Screen, Subtitle, Title } from "../ui";

export default function AuthCallback() {
  const t = useTheme();
  const { status } = useSession();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (status === "ready" || status === "onboarding") router.replace("/");
  }, [status]);

  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), 12000);
    return () => clearTimeout(id);
  }, []);

  if (timedOut && status === "signedOut") {
    return (
      <Screen>
        <Title>Sign-in didn't complete</Title>
        <Subtitle>We didn't receive a valid session. Please try again.</Subtitle>
        <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.md }}>
          You can also sign in with your email and password.
        </Text>
        <Button label="Back to sign in" onPress={() => router.replace("/auth")} />
      </Screen>
    );
  }
  return <LoadingView />;
}
