// Offline cache: SQLite on iOS/Android, in-memory no-op on web (offline
// support is a native feature; web always talks to the backend directly).
// The cache lives in the app sandbox (OS data protection at rest) and is
// wiped completely on sign-out. Records are stored as JSON blobs keyed by
// id + workspace, with the mutation queue and conflict list alongside.

import { Platform } from "react-native";

type Row = Record<string, any>;

interface CacheDb {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  kvRemove(key: string): void;
  upsertRecords(table: "containers" | "items" | "locations", workspaceId: string, records: Row[]): void;
  getRecords(table: "containers" | "items" | "locations", workspaceId: string): Row[];
  pruneToLocations(workspaceId: string, accessible: string[] | null): void;
  enqueueMutation(workspaceId: string, kind: string, payload: Row): string;
  listMutations(workspaceId: string): Array<{ id: string; kind: string; payload: Row }>;
  removeMutation(id: string): void;
  saveConflict(workspaceId: string, conflict: Row): void;
  listConflicts(workspaceId: string): Array<{ id: string; data: Row }>;
  removeConflict(id: string): void;
  wipeAll(): void;
}

function makeNativeDb(): CacheDb {
  // Required lazily so the web bundle never touches the native module.
  const SQLite = require("expo-sqlite");
  const db = SQLite.openDatabaseSync("findmybins-cache.db");
  db.execSync(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (
      id TEXT NOT NULL, tbl TEXT NOT NULL, workspace_id TEXT NOT NULL,
      location_id TEXT, data TEXT NOT NULL,
      PRIMARY KEY (tbl, id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_ws ON records (tbl, workspace_id);
    CREATE TABLE IF NOT EXISTS mutations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  return {
    kvGet: (k) => (db.getFirstSync("SELECT v FROM kv WHERE k = ?", [k]) as any)?.v ?? null,
    kvSet: (k, v) => { db.runSync("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", [k, v]); },
    kvRemove: (k) => { db.runSync("DELETE FROM kv WHERE k = ?", [k]); },
    upsertRecords: (tbl, ws, records) => {
      for (const r of records) {
        db.runSync(
          "INSERT OR REPLACE INTO records (id, tbl, workspace_id, location_id, data) VALUES (?, ?, ?, ?, ?)",
          [r.id, tbl, ws, r.location_id ?? null, JSON.stringify(r)],
        );
      }
    },
    getRecords: (tbl, ws) =>
      (db.getAllSync("SELECT data FROM records WHERE tbl = ? AND workspace_id = ?", [tbl, ws]) as any[])
        .map((row) => JSON.parse(row.data)),
    pruneToLocations: (ws, accessible) => {
      if (accessible === null) return;
      const rows = db.getAllSync(
        "SELECT id, tbl, location_id FROM records WHERE workspace_id = ? AND tbl != 'locations'", [ws],
      ) as any[];
      for (const row of rows) {
        if (row.location_id && !accessible.includes(row.location_id)) {
          db.runSync("DELETE FROM records WHERE tbl = ? AND id = ?", [row.tbl, row.id]);
        }
      }
      db.runSync(
        `DELETE FROM records WHERE tbl = 'locations' AND workspace_id = ? AND id NOT IN (${accessible.map(() => "?").join(",") || "''"})`,
        [ws, ...accessible],
      );
    },
    enqueueMutation: (ws, kind, payload) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      db.runSync(
        "INSERT INTO mutations (id, workspace_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, ws, kind, JSON.stringify(payload), new Date().toISOString()],
      );
      return id;
    },
    listMutations: (ws) =>
      (db.getAllSync("SELECT id, kind, payload FROM mutations WHERE workspace_id = ? ORDER BY created_at", [ws]) as any[])
        .map((row) => ({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload) })),
    removeMutation: (id) => { db.runSync("DELETE FROM mutations WHERE id = ?", [id]); },
    saveConflict: (ws, conflict) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      db.runSync(
        "INSERT INTO conflicts (id, workspace_id, data, created_at) VALUES (?, ?, ?, ?)",
        [id, ws, JSON.stringify(conflict), new Date().toISOString()],
      );
    },
    listConflicts: (ws) =>
      (db.getAllSync("SELECT id, data FROM conflicts WHERE workspace_id = ? ORDER BY created_at", [ws]) as any[])
        .map((row) => ({ id: row.id, data: JSON.parse(row.data) })),
    removeConflict: (id) => { db.runSync("DELETE FROM conflicts WHERE id = ?", [id]); },
    wipeAll: () => {
      db.execSync("DELETE FROM kv; DELETE FROM records; DELETE FROM mutations; DELETE FROM conflicts;");
    },
  };
}

/** Web: volatile stub — the web app is online-only by design. */
function makeMemoryDb(): CacheDb {
  const kv = new Map<string, string>();
  const records = new Map<string, Row>();
  const mutations: Array<{ id: string; workspace_id: string; kind: string; payload: Row }> = [];
  const conflicts: Array<{ id: string; workspace_id: string; data: Row }> = [];
  return {
    kvGet: (k) => kv.get(k) ?? null,
    kvSet: (k, v) => { kv.set(k, v); },
    kvRemove: (k) => { kv.delete(k); },
    upsertRecords: (tbl, ws, rs) => { for (const r of rs) records.set(`${tbl}:${r.id}`, { ...r, __tbl: tbl, __ws: ws }); },
    getRecords: (tbl, ws) => [...records.values()].filter((r) => r.__tbl === tbl && r.__ws === ws),
    pruneToLocations: () => {},
    enqueueMutation: (ws, kind, payload) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      mutations.push({ id, workspace_id: ws, kind, payload });
      return id;
    },
    listMutations: (ws) => mutations.filter((m) => m.workspace_id === ws),
    removeMutation: (id) => {
      const i = mutations.findIndex((m) => m.id === id);
      if (i >= 0) mutations.splice(i, 1);
    },
    saveConflict: (ws, data) => {
      conflicts.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, workspace_id: ws, data });
    },
    listConflicts: (ws) => conflicts.filter((c) => c.workspace_id === ws),
    removeConflict: (id) => {
      const i = conflicts.findIndex((c) => c.id === id);
      if (i >= 0) conflicts.splice(i, 1);
    },
    wipeAll: () => { kv.clear(); records.clear(); mutations.length = 0; conflicts.length = 0; },
  };
}

let instance: CacheDb | null = null;
export function cache(): CacheDb {
  if (!instance) instance = Platform.OS === "web" ? makeMemoryDb() : makeNativeDb();
  return instance;
}
