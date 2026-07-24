// Singleton API client with platform-appropriate token storage:
// SecureStore on iOS/Android, localStorage on web.

// Must be first: installs crypto.getRandomValues before the SDK client (below)
// or any uuid-using SDK call runs on device. See crypto-polyfill.ts.
import "./crypto-polyfill";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createApi, type TokenStorage } from "@findmybins/api-client";

const webStorage: TokenStorage = {
  async get(key) {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  async set(key, value) {
    try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode */ }
  },
  async remove(key) {
    try { globalThis.localStorage?.removeItem(key); } catch { /* private mode */ }
  },
};

const nativeStorage: TokenStorage = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

export const storage: TokenStorage = Platform.OS === "web" ? webStorage : nativeStorage;
export const api = createApi(storage);
