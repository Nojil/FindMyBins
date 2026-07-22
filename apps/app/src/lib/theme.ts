// FindMyBins design tokens. Warm light neutrals, white cards, blue/teal/navy
// brand palette, rounded corners, generous spacing. QR codes and photos are
// never theme-inverted.

import { useColorScheme } from "react-native";

export const palette = {
  blue: "#1E6FD9",
  blueDark: "#1558B0",
  teal: "#14B8A6",
  aqua: "#67E8F9",
  navy: "#0F2A43",
};

export interface Theme {
  dark: boolean;
  bg: string;
  card: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  accent: string;
  danger: string;
  inputBg: string;
  tabBar: string;
}

export const lightTheme: Theme = {
  dark: false,
  bg: "#FAF8F4",
  card: "#FFFFFF",
  border: "#E9E4DB",
  text: "#1A2733",
  textMuted: "#64707C",
  primary: palette.blue,
  primaryText: "#FFFFFF",
  accent: palette.teal,
  danger: "#C4453B",
  inputBg: "#FFFFFF",
  tabBar: "#FFFFFF",
};

export const darkTheme: Theme = {
  dark: true,
  bg: "#0E141B",
  card: "#182230",
  border: "#26344455",
  text: "#EDF1F5",
  textMuted: "#94A3B2",
  primary: "#4C94E8",
  primaryText: "#FFFFFF",
  accent: palette.teal,
  danger: "#E06A61",
  inputBg: "#121C27",
  tabBar: "#131D28",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? darkTheme : lightTheme;
}

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 10, md: 14, lg: 20 };
