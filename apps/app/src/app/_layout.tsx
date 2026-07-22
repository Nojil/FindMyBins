import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../lib/session";
import { SyncProvider } from "../lib/offline";
import { useTheme } from "../lib/theme";

function RootStack() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.bg },
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <SyncProvider>
          <StatusBar style="auto" />
          <RootStack />
        </SyncProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
