import React from "react";
import { View, type ColorValue } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSession } from "../../lib/session";
import { useTheme } from "../../lib/theme";
import { LoadingView } from "../../ui";

export default function TabsLayout() {
  const t = useTheme();
  const { status } = useSession();
  if (status === "loading") return <LoadingView />;
  if (status === "signedOut") return <Redirect href="/auth" />;
  if (status === "onboarding") return <Redirect href="/onboarding" />;

  const icon = (name: keyof typeof Ionicons.glyphMap) =>
    ({ color, size }: { color: ColorValue; size: number }) =>
      <Ionicons name={name} size={size} color={color} />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: { backgroundColor: t.tabBar, borderTopColor: t.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("home") }} />
      <Tabs.Screen name="search" options={{ title: "Search", tabBarIcon: icon("search") }} />
      <Tabs.Screen
        name="scan"
        options={{
          title: "Scan",
          tabBarIcon: ({ size }) => (
            <View
              style={{
                width: size + 26, height: size + 26, borderRadius: (size + 26) / 2,
                backgroundColor: t.primary, alignItems: "center", justifyContent: "center",
                marginTop: -14, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 6,
                shadowOffset: { width: 0, height: 3 }, elevation: 4,
              }}
            >
              <Ionicons name="qr-code" size={size + 2} color="#FFFFFF" />
            </View>
          ),
        }}
      />
      <Tabs.Screen name="containers" options={{ title: "Containers", tabBarIcon: icon("cube") }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: icon("ellipsis-horizontal") }} />
    </Tabs>
  );
}
