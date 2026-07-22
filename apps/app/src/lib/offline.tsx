// Sync engine + provider. States surfaced to the UI: Online, Offline,
// Syncing, Waiting to Sync (queued mutations), Needs Attention (conflicts),
// and cache-locked when the offline revalidation window has expired.
// Local-only data is never presented as backed up.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Network from "expo-network";
import { api } from "./api";
import { cache } from "./db";

interface SyncState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  conflictCount: number;
  lastSyncAt: string | null;
  cacheLocked: boolean;
  syncNow: (workspaceId: string) => Promise<void>;
  enqueue: (workspaceId: string, kind: string, payload: Record<string, any>) => void;
  refreshCounts: (workspaceId: string) => void;
}

const SyncContext = createContext<SyncState | null>(null);

const kvKey = (ws: string, k: string) => `${k}:${ws}`;

export function offlineContainers(workspaceId: string) {
  return cache().getRecords("containers", workspaceId);
}
export function offlineItems(workspaceId: string, containerId?: string) {
  const all = cache().getRecords("items", workspaceId);
  return containerId ? all.filter((i) => i.container_id === containerId) : all;
}
export function offlineLocations(workspaceId: string) {
  return cache().getRecords("locations", workspaceId);
}
export function offlineContainerByQr(workspaceId: string, qrToken: string) {
  return cache().getRecords("containers", workspaceId).find((c) => c.qr_token === qrToken) ?? null;
}
export function offlineConflicts(workspaceId: string) {
  return cache().listConflicts(workspaceId);
}
export function resolveConflictKeepServer(conflictId: string) {
  cache().removeConflict(conflictId);
}
export function resolveConflictKeepMine(workspaceId: string, conflictId: string, conflict: Record<string, any>) {
  // Re-apply the client's change against the latest server version.
  const payload = { ...conflict.client_payload, base_updated_date: conflict.server_record?.updated_date };
  cache().enqueueMutation(workspaceId, conflict.mutation_kind, payload);
  cache().removeConflict(conflictId);
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [cacheLocked, setCacheLocked] = useState(false);
  const syncingRef = useRef(false);

  useEffect(() => {
    if (Platform.OS === "web") {
      const update = () => setOnline(globalThis.navigator?.onLine !== false);
      update();
      globalThis.addEventListener?.("online", update);
      globalThis.addEventListener?.("offline", update);
      return () => {
        globalThis.removeEventListener?.("online", update);
        globalThis.removeEventListener?.("offline", update);
      };
    }
    let sub: { remove(): void } | null = null;
    (async () => {
      const state = await Network.getNetworkStateAsync().catch(() => null);
      if (state) setOnline(state.isConnected !== false);
      sub = Network.addNetworkStateListener(({ isConnected }) => setOnline(isConnected !== false));
    })();
    return () => sub?.remove();
  }, []);

  const refreshCounts = useCallback((workspaceId: string) => {
    setPendingCount(cache().listMutations(workspaceId).length);
    setConflictCount(cache().listConflicts(workspaceId).length);
    const last = cache().kvGet(kvKey(workspaceId, "last_sync"));
    setLastSyncAt(last);
    const policyRaw = cache().kvGet(kvKey(workspaceId, "policy"));
    if (last && policyRaw) {
      const policy = JSON.parse(policyRaw);
      const ageDays = (Date.now() - new Date(last).getTime()) / 86400_000;
      setCacheLocked(policy.mode === "disabled" || ageDays > (policy.revalidate_days ?? 30));
    } else {
      setCacheLocked(false);
    }
  }, []);

  const syncNow = useCallback(async (workspaceId: string) => {
    if (syncingRef.current || !workspaceId) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const db = cache();

      // 1. Push the mutation queue in order.
      const queue = db.listMutations(workspaceId);
      if (queue.length) {
        const res = await api.invoke<any>("api/sync", "push", {
          workspace_id: workspaceId,
          mutations: queue.map((m) => ({ client_mutation_id: m.id, kind: m.kind, payload: m.payload })),
        });
        for (const r of res.results ?? []) {
          const original = queue.find((m) => m.id === r.client_mutation_id);
          db.removeMutation(r.client_mutation_id);
          if (r.status === "applied" && r.record) {
            db.upsertRecords(r.kind === "item" ? "items" : "containers", workspaceId, [r.record]);
          } else if (r.status === "conflict") {
            db.saveConflict(workspaceId, { ...r, mutation_kind: original?.kind });
            if (r.server_record) {
              db.upsertRecords(r.kind === "item" ? "items" : "containers", workspaceId, [r.server_record]);
            }
          }
          // Rejected mutations are dropped; the server refused them outright.
        }
      }

      // 2. Pull deltas.
      const cursorsRaw = db.kvGet(kvKey(workspaceId, "cursors"));
      const cursors = cursorsRaw ? JSON.parse(cursorsRaw) : {};
      const pull = await api.invoke<any>("api/sync", "pull", { workspace_id: workspaceId, cursors });
      db.upsertRecords("locations", workspaceId, pull.changes.locations.records);
      db.upsertRecords("containers", workspaceId, pull.changes.containers.records);
      db.upsertRecords("items", workspaceId, pull.changes.items.records);
      db.pruneToLocations(workspaceId, pull.accessible_location_ids);
      db.kvSet(kvKey(workspaceId, "cursors"), JSON.stringify({
        locations: pull.changes.locations.cursor,
        containers: pull.changes.containers.cursor,
        items: pull.changes.items.cursor,
      }));
      db.kvSet(kvKey(workspaceId, "policy"), JSON.stringify(pull.policy));
      db.kvSet(kvKey(workspaceId, "last_sync"), pull.server_time);
    } catch (err) {
      console.warn("[sync] sync failed:", err);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      refreshCounts(workspaceId);
    }
  }, [refreshCounts]);

  const enqueue = useCallback((workspaceId: string, kind: string, payload: Record<string, any>) => {
    cache().enqueueMutation(workspaceId, kind, payload);
    refreshCounts(workspaceId);
  }, [refreshCounts]);

  const value = useMemo<SyncState>(() => ({
    online, syncing, pendingCount, conflictCount, lastSyncAt, cacheLocked,
    syncNow, enqueue, refreshCounts,
  }), [online, syncing, pendingCount, conflictCount, lastSyncAt, cacheLocked, syncNow, enqueue, refreshCounts]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncState {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used inside SyncProvider");
  return ctx;
}
