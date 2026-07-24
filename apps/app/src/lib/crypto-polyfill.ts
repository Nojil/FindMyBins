// The Base44 SDK generates request ids with `uuid`, which calls the Web Crypto
// `crypto.getRandomValues()`. Hermes / React Native does not provide it, so on
// device the SDK throws "crypto.getRandomValues() not supported" (e.g. on email
// /password sign-in). Expo Go ships expo-crypto, which implements exactly that
// Web Crypto method — install it onto the global so the SDK finds it.
//
// This must run before any SDK call, so it is imported first in lib/api.ts
// (where the client is created). Dependency-free in Expo Go: expo-crypto is
// already a dependency and part of the Expo Go runtime.
import { getRandomValues as expoGetRandomValues } from "expo-crypto";

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto !== "object" || g.crypto === null) {
  (g as { crypto: object }).crypto = {};
}
if (typeof g.crypto!.getRandomValues !== "function") {
  g.crypto!.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array) expoGetRandomValues(array as unknown as Parameters<typeof expoGetRandomValues>[0]);
    return array;
  };
}
