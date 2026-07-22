// Search: typo/synonym-aware keyword search with private history.

import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { SearchContainerResult, SearchItemResult } from "@findmybins/core";
import type { NaturalSearchResult } from "@findmybins/api-client";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { spacing, useTheme } from "../../lib/theme";
import { Badge, Card, EmptyState, Screen, SectionTitle, TextField, Title } from "../../ui";

export default function Search() {
  const t = useTheme();
  const { workspace } = useSession();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ items: SearchItemResult[]; containers: SearchContainerResult[]; exact_only: boolean } | null>(null);
  const [nlResult, setNlResult] = useState<NaturalSearchResult | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; query_text: string }>>([]);

  const loadHistory = useCallback(async () => {
    if (!workspace) return;
    try {
      const res = await api.search.history(workspace.id);
      setHistory(res.history);
    } catch { /* history is best-effort */ }
  }, [workspace?.id]);

  useEffect(() => { setResults(null); setQuery(""); loadHistory(); }, [workspace?.id]);

  const run = async (q: string) => {
    if (!workspace || !q.trim()) return;
    setBusy(true);
    setNlResult(null);
    try {
      const res = await api.search.keyword(workspace.id, q.trim());
      setResults(res);
      loadHistory();
    } catch {
      setResults({ items: [], containers: [], exact_only: true });
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    if (!workspace || !query.trim()) return;
    setBusy(true);
    setResults(null);
    try {
      setNlResult(await api.search.natural(workspace.id, query.trim()));
      loadHistory();
    } catch {
      setNlResult({ query, answer: "Couldn't get an answer right now.", no_reliable_result: true, matches: [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>Search</Title>
      <TextField
        placeholder="fall pillows, HDMI cables, tablecloths…"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => run(query)}
        returnKeyType="search"
        autoCorrect={false}
      />

      {workspace && workspace.plan !== "free" && query.trim().length > 0 && (
        <Pressable
          onPress={ask}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center",
            borderRadius: 999, borderWidth: 1.5, borderColor: t.accent,
            paddingVertical: 10, marginBottom: spacing.md,
          }}
        >
          <Ionicons name="sparkles-outline" size={16} color={t.accent} />
          <Text style={{ color: t.accent, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
            Ask AI: “{query.trim().slice(0, 40)}”
          </Text>
        </Pressable>
      )}

      {nlResult && !busy && (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <Ionicons name="sparkles" size={18} color={t.accent} style={{ marginTop: 2 }} />
            <Text style={{ color: t.text, fontSize: 15, lineHeight: 22, marginLeft: spacing.sm, flex: 1 }}>
              {nlResult.answer}
            </Text>
          </View>
        </Card>
      )}
      {nlResult && !busy && nlResult.matches.map((m, idx) => (
        <Card key={`${m.item?.id ?? m.container?.id}-${idx}`} onPress={() => m.container && router.push(`/container/${m.container.id}`)}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              {m.item && <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{m.item.name}</Text>}
              {m.container && (
                <Text style={{ color: t.text, fontSize: 14, marginTop: m.item ? 4 : 0 }}>
                  {m.container.number_display}: {m.container.title}
                </Text>
              )}
              {m.location_path && <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>{m.location_path}</Text>}
              {m.item && (
                <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>
                  {m.item.quantity != null ? `Quantity: ${m.item.quantity}` : "Quantity not specified"}
                </Text>
              )}
            </View>
            {m.match === "possible" && <Badge label="possible" tone="warn" />}
            <Ionicons name="chevron-forward" size={18} color={t.textMuted} style={{ marginLeft: 6 }} />
          </View>
        </Card>
      ))}

      {!results && !nlResult && history.length > 0 && (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <SectionTitle>Recent searches</SectionTitle>
            <Pressable onPress={async () => { if (workspace) { await api.search.historyClear(workspace.id); setHistory([]); } }}>
              <Text style={{ color: t.primary, fontSize: 13, fontWeight: "600" }}>Clear</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {history.slice(0, 10).map((h) => (
              <Pressable
                key={h.id}
                onPress={() => { setQuery(h.query_text); run(h.query_text); }}
                style={{
                  backgroundColor: t.card, borderColor: t.border, borderWidth: 1,
                  borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
                }}
              >
                <Text style={{ color: t.text, fontSize: 14 }}>{h.query_text}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {busy && <Text style={{ color: t.textMuted, marginTop: spacing.md }}>Searching…</Text>}

      {results && !busy && results.items.length === 0 && results.containers.length === 0 && (
        <EmptyState
          icon="search-outline"
          title="No matches"
          body="Nothing in your searchable containers matches that. Try a different word."
        />
      )}

      {results && results.items.length > 0 && (
        <>
          <SectionTitle>Items</SectionTitle>
          {!results.exact_only && (
            <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.sm }}>
              Includes possible matches.
            </Text>
          )}
          {results.items.map((r, idx) => (
            <Card key={`${r.item.id}-${idx}`} onPress={() => r.container && router.push(`/container/${r.container.id}`)}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{r.item.name}</Text>
                    {r.match === "possible" && <Badge label="possible" tone="warn" />}
                  </View>
                  {r.container && (
                    <Text style={{ color: t.text, fontSize: 14, marginTop: 4 }}>
                      {r.container.number_display}: {r.container.title}
                    </Text>
                  )}
                  {r.location_path && (
                    <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>{r.location_path}</Text>
                  )}
                  <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>
                    {r.item.quantity != null ? `Quantity: ${r.item.quantity}` : "Quantity not specified"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
              </View>
            </Card>
          ))}
        </>
      )}

      {results && results.containers.length > 0 && (
        <>
          <SectionTitle>Containers</SectionTitle>
          {results.containers.map((r, idx) => (
            <Card key={`${r.container.id}-${idx}`} onPress={() => router.push(`/container/${r.container.id}`)}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>
                    {r.container.number_display}: {r.container.title}
                  </Text>
                  {r.location_path && (
                    <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>{r.location_path}</Text>
                  )}
                </View>
                {r.match === "possible" && <Badge label="possible" tone="warn" />}
              </View>
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
