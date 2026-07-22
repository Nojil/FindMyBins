import React from "react";
import { Redirect } from "expo-router";
import { useSession } from "../lib/session";
import { LoadingView } from "../ui";

export default function Index() {
  const { status } = useSession();
  if (status === "loading") return <LoadingView />;
  if (status === "signedOut") return <Redirect href="/auth" />;
  if (status === "onboarding") return <Redirect href="/onboarding" />;
  return <Redirect href="/(tabs)" />;
}
