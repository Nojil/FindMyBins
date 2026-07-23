// Session state machine shared by every screen.
// signedOut → (auth) → onboarding (no 18+/terms or no workspace) → ready.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as Linking from "expo-linking";
import type { Profile, WorkspaceSummary } from "@findmybins/core";
import { ApiError } from "@findmybins/api-client";
import { api, storage } from "./api";
import { cache } from "./db";

const WS_KEY = "fmb_current_workspace";

type Status = "loading" | "signedOut" | "onboarding" | "ready";

interface Session {
  status: Status;
  profile: Profile | null;
  workspaces: WorkspaceSummary[];
  workspace: WorkspaceSummary | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const boot = await api.workspaces.bootstrap();
      setProfile(boot.profile);
      setWorkspaces(boot.workspaces);
      const stored = await storage.get(WS_KEY);
      const validStored = boot.workspaces.find((w) => w.id === stored)?.id;
      const current = validStored ?? boot.workspaces[0]?.id ?? null;
      setWorkspaceId(current);
      const onboarded = boot.profile.is_18_or_over && boot.profile.terms_accepted_at && boot.workspaces.length > 0;
      setStatus(onboarded ? "ready" : "onboarding");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setStatus("signedOut");
      } else {
        // Network/server problem with a stored token: keep the user signed in
        // but surface nothing to render yet; screens show their own errors.
        setStatus("signedOut");
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const restored = await api.auth.restore();
      if (!restored) {
        setStatus("signedOut");
        return;
      }
      await refresh();
    })();
  }, [refresh]);

  /**
   * Adopt an access token arriving on a deep link, wherever the app happens to
   * be. Native OAuth returns through the relay page to findmybins://auth-callback
   * (exp:// in Expo Go); handling it here rather than in a screen means it works
   * on a cold start and on resume, and doesn't depend on the router having
   * hydrated its params yet — which is what previously dropped the token and
   * bounced the user back to sign-in.
   */
  useEffect(() => {
    let cancelled = false;
    const adopt = async (url: string | null) => {
      if (!url || cancelled) return;
      const match = url.match(/[?&#]access_token=([^&#]+)/);
      if (!match) return;
      try {
        await api.auth.adoptToken(decodeURIComponent(match[1]));
        if (!cancelled) await refresh();
      } catch {
        // Leave the session as-is; the sign-in screen reports the failure.
      }
    };
    Linking.getInitialURL().then(adopt).catch(() => {});
    const sub = Linking.addEventListener("url", (event) => { void adopt(event.url); });
    return () => { cancelled = true; sub.remove(); };
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    await api.auth.signIn(email, password);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.auth.signOut();
    await storage.remove(WS_KEY);
    // Offline cache is removed with the account's session, per the offline policy.
    try { cache().wipeAll(); } catch { /* cache may be uninitialized */ }
    setProfile(null);
    setWorkspaces([]);
    setWorkspaceId(null);
    setStatus("signedOut");
  }, []);

  const selectWorkspace = useCallback(async (id: string) => {
    setWorkspaceId(id);
    await storage.set(WS_KEY, id);
  }, []);

  const value = useMemo<Session>(() => ({
    status,
    profile,
    workspaces,
    workspace: workspaces.find((w) => w.id === workspaceId) ?? null,
    refresh,
    signIn,
    signOut,
    selectWorkspace,
  }), [status, profile, workspaces, workspaceId, refresh, signIn, signOut, selectWorkspace]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
