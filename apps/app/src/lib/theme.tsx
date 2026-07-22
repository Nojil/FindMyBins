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

// "Graphite Elevation": depth comes from layered shadows rather than borders
// or blur. Cool neutral light mode, charcoal dark mode, solid-fill cards.

export const palette = {
  blue: "#1E6FD9",
  blueDark: "#1558B0",
  teal: "#14B8A6",
  violet: "#7C6FEE",
  violetDark: "#9C8CF5",
  aqua: "#67E8F9",
  navy: "#0F2A43",
};

export interface Theme {
  dark: boolean;
  /** Solid fallback fill; `bgGradient` is what Screen actually paints. */
  bg: string;
  bgGradient: readonly [string, string];
  card: string;
  /** Slightly raised surface for grouped rows and inputs on top of cards. */
  elevated: string;
  /**
   * Subtle line/fill colour. Cards, inputs, and chips no longer draw a border
   * (elevation carries them) — this remains for dividers, progress tracks,
   * step dots, and unselected option outlines.
   */
  border: string;
  /** Hairline above the tab bar. */
  divider: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  accent: string;
  /** Third stat accent (Locations tile). */
  violet: string;
  danger: string;
  warning: string;
  inputBg: string;
  tabBar: string;
}

export const lightTheme: Theme = {
  dark: false,
  bg: "#F4F6F8",
  bgGradient: ["#F4F6F8", "#EDEFF2"],
  card: "#FFFFFF",
  elevated: "#EDEFF2",
  border: "#DDE2E7",
  divider: "rgba(16,24,32,0.06)",
  text: "#17212B",
  textMuted: "#64707C",
  primary: palette.blue,
  primaryText: "#FFFFFF",
  accent: palette.teal,
  violet: palette.violet,
  danger: "#C4453B",
  warning: "#B45309",
  inputBg: "#FFFFFF",
  tabBar: "#FFFFFF",
};

export const darkTheme: Theme = {
  dark: true,
  bg: "#1B222B",
  bgGradient: ["#1B222B", "#141A21"],
  card: "#212A33",
  elevated: "#1A222B",
  border: "#33404D",
  divider: "rgba(255,255,255,0.06)",
  text: "#EDF1F5",
  textMuted: "#94A3B2",
  primary: "#4C94E8",
  primaryText: "#FFFFFF",
  accent: "#2DD4BF",
  violet: palette.violetDark,
  danger: "#E06A61",
  warning: "#F5B968",
  inputBg: "#212A33",
  tabBar: "#171E25",
};

/**
 * Shared elevation recipes. React Native takes a single shadow, so each is the
 * visual equivalent of the mock's layered pair, plus an Android `elevation`.
 */
export function elevation(t: Theme) {
  return {
    /** Cards, list rows, inputs, search bar, stat tiles. */
    card: t.dark
      ? { shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6 }
      : { shadowColor: "#101820", shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
    /** Smaller lift for pills and chips. */
    chip: t.dark
      ? { shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 }
      : { shadowColor: "#101820", shadowOpacity: 0.05, shadowRadius: 7, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
    /** Coloured glow under the primary button and the centre Scan action. */
    primary: t.dark
      ? { shadowColor: "#4C94E8", shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 }
      : { shadowColor: palette.blue, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  };
}

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
