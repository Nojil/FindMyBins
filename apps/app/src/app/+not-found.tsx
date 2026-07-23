// Catch-all. Its main job is a graceful "not found", but it also rescues an
// OAuth token that arrives on an unexpected deep-link path (e.g. a cached relay
// pointing at a route that changed). SessionProvider's handler adopts the
// token from the URL; here we just wait for the session and move on so the user
// never gets stranded on an "unmatched route" screen holding a valid token.

import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { router, usePathname } from "expo-router";
import { useSession } from "../lib/session";
import { spacing, useTheme } from "../lib/theme";
import { Button, LoadingView, Screen, Subtitle, Title } from "../ui";

export default function NotFound() {
  const t = useTheme();
  const { status } = useSession();
  const pathname = usePathname();
  // A returning OAuth deep link carries the token; wait for adoption.
  const looksLikeAuth = /auth|token|callback/i.test(pathname ?? "");
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    if (status === "ready" || status === "onboarding") router.replace("/");
  }, [status]);

  useEffect(() => {
    const id = setTimeout(() => setWaited(true), looksLikeAuth ? 8000 : 0);
    return () => clearTimeout(id);
  }, [looksLikeAuth]);

  if (looksLikeAuth && !waited) return <LoadingView />;

  return (
    <Screen>
      <Title>Page not found</Title>
      <Subtitle>That screen doesn't exist.</Subtitle>
      <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.md }}>{pathname}</Text>
      <Button label="Go home" onPress={() => router.replace("/")} />
    </Screen>
  );
}
