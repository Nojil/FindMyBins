import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../lib/session";
import { SyncProvider } from "../lib/offline";
import { ThemeProvider, useTheme, useThemeMode } from "../lib/theme";

function RootStack() {
  const t = useTheme();
  const { resolved } = useThemeMode();
  return (
    <>
      {/* Status bar follows the chosen theme, not just the device. */}
      <StatusBar style={resolved === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* Outermost so auth and loading screens are themed too. */}
      <ThemeProvider>
        <SessionProvider>
          <SyncProvider>
            <RootStack />
          </SyncProvider>
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
