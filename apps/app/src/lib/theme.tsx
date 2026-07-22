// FindMyBins design tokens + theme control.
//
// Appearance follows the device by default and can be overridden to Light or
// Dark. The choice is written locally first (so it applies instantly on the
// next launch, before the session loads) and mirrored to the user's profile so
// it follows them across devices.
//
// QR codes, printed labels, and photos are never theme-inverted.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { api, storage } from "./api";

export const palette = {
  blue: "#1E6FD9",
  blueDark: "#1558B0",
  teal: "#0D9488",
  aqua: "#67E8F9",
  navy: "#0F2A43",
};

export interface Theme {
  dark: boolean;
  bg: string;
  card: string;
  /** Slightly raised surface for grouped rows and inputs on top of cards. */
  elevated: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  accent: string;
  danger: string;
  warning: string;
  inputBg: string;
  tabBar: string;
}

export const lightTheme: Theme = {
  dark: false,
  bg: "#FAF8F4",
  card: "#FFFFFF",
  elevated: "#F4F1EB",
  border: "#E4DFD6",
  text: "#16212C",
  textMuted: "#5C6874",
  primary: palette.blue,
  primaryText: "#FFFFFF",
  accent: palette.teal,
  danger: "#B4392F",
  warning: "#B45309",
  inputBg: "#FFFFFF",
  tabBar: "#FFFFFF",
};

export const darkTheme: Theme = {
  dark: true,
  bg: "#0E141B",
  card: "#182230",
  elevated: "#1F2B3A",
  border: "#2A3746",
  text: "#EDF1F5",
  textMuted: "#9BA9B8",
  primary: "#5B9EEC",
  primaryText: "#08121C",
  accent: "#2DD4BF",
  danger: "#F08A80",
  warning: "#FBBF24",
  inputBg: "#121C27",
  tabBar: "#131D28",
};

export type ThemeMode = "system" | "light" | "dark";
const MODE_KEY = "fmb_theme_mode";

interface ThemeControl {
  mode: ThemeMode;
  /** The scheme actually being rendered once `system` is resolved. */
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<{ theme: Theme; control: ThemeControl } | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [hydrated, setHydrated] = useState(false);

  // Apply any stored choice as early as possible.
  useEffect(() => {
    (async () => {
      const stored = await storage.get(MODE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") setModeState(stored);
      setHydrated(true);
    })();
  }, []);

  // Once signed in, adopt the profile's preference if this device has none.
  useEffect(() => {
    if (!hydrated) return;
    (async () => {
      const stored = await storage.get(MODE_KEY);
      if (stored) return;
      try {
        const boot = await api.workspaces.bootstrap();
        const remote = boot.profile?.theme;
        if (remote === "light" || remote === "dark" || remote === "system") setModeState(remote);
      } catch {
        // Signed out or offline — the device default stands.
      }
    })();
  }, [hydrated]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void storage.set(MODE_KEY, next);
    // Best-effort sync so the choice follows the user to other devices.
    void api.workspaces.updateProfile({ theme: next }).catch(() => {});
  }, []);

  const resolved: "light" | "dark" =
    mode === "system" ? (systemScheme === "dark" ? "dark" : "light") : mode;

  const value = useMemo(() => ({
    theme: resolved === "dark" ? darkTheme : lightTheme,
    control: { mode, resolved, setMode },
  }), [resolved, mode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Colors for the active theme. Falls back to the system scheme outside a provider. */
export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  const systemScheme = useColorScheme();
  if (ctx) return ctx.theme;
  return systemScheme === "dark" ? darkTheme : lightTheme;
}

/** Read and change the appearance preference. */
export function useThemeMode(): ThemeControl {
  const ctx = useContext(ThemeContext);
  const systemScheme = useColorScheme();
  if (!ctx) {
    return { mode: "system", resolved: systemScheme === "dark" ? "dark" : "light", setMode: () => {} };
  }
  return ctx.control;
}

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 10, md: 14, lg: 20 };
