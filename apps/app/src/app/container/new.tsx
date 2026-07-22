// Three-step container creation: 1) basics & location  2) contents  3) label.

import React, { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CONTAINER_TYPES, type Container, type ContainerType, type LocationNode } from "@findmybins/core";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { cache } from "../../lib/db";
import { offlineLocations, useSync } from "../../lib/offline";
import { radius, spacing, useTheme } from "../../lib/theme";
import { Button, Card, Screen, Subtitle, TextField, Title } from "../../ui";

export default function NewContainer() {
  const t = useTheme();
  const { workspace } = useSession();
  const sync = useSync();
  const [step, setStep] = useState(1);
  const [locations, setLocations] = useState<LocationNode[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [newLocationName, setNewLocationName] = useState("");
  const [type, setType] = useState<ContainerType>("bin");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [lines, setLines] = useState("");
  const [container, setContainer] = useState<Container | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!workspace) return;
      if (!sync.online) {
        const cached = offlineLocations(workspace.id).filter((l) => !l.archived) as LocationNode[];
        setLocations(cached);
        if (cached.length === 1) setLocationId(cached[0].id);
        return;
      }
      try {
        const res = await api.locations.list(workspace.id);
        setLocations(res.locations);
        if (res.locations.length === 1) setLocationId(res.locations[0].id);
      } catch { /* handled by empty state below */ }
    })();
  }, [workspace?.id, sync.online]);

  // Offline path: queue the creation, show a Pending Number record locally.
  const createOffline = () => {
    if (!workspace) return;
    if (!locationId) {
      setError("Pick an existing location — new locations need a connection.");
      return;
    }
    if (!title.trim()) {
      setError("Give the container a title.");
      return;
    }
    const clientUuid = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    sync.enqueue(workspace.id, "create_container", {
      client_uuid: clientUuid,
      location_id: locationId,
      title: title.trim(),
      container_type: type,
      category: category.trim() || undefined,
    });
    cache().upsertRecords("containers", workspace.id, [{
      id: `local:${clientUuid}`, client_uuid: clientUuid, workspace_id: workspace.id,
      location_id: locationId, title: title.trim(), container_type: type,
      category: category.trim() || undefined, number: null, number_display: null,
      pending_number: true, label_status: "not_printed", archived: false, tags: [],
    }]);
    router.replace("/(tabs)/containers");
  };

  const createContainer = async () => {
    if (!workspace) return;
    setError(null);
    let loc = locationId;
    setBusy(true);
    try {
      if (!loc && newLocationName.trim()) {
        const res = await api.locations.create(workspace.id, newLocationName.trim());
        loc = res.location.id;
      }
      if (!loc) {
        setError("Pick a location or create one.");
        return;
      }
      if (!title.trim()) {
        setError("Give the container a title.");
        return;
      }
      const res = await api.containers.create(workspace.id, {
        location_id: loc,
        title: title.trim(),
        container_type: type,
        category: category.trim() || undefined,
      });
      setContainer(res.container);
      setStep(2);
    } catch (err: any) {
      setError(err?.code === "plan_limit"
        ? "You've reached this plan's container limit. Upgrade to add more."
        : "Couldn't create the container. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const addContents = async () => {
    if (!workspace || !container) return;
    setBusy(true);
    try {
      if (lines.trim()) await api.items.quickAdd(workspace.id, container.id, lines);
      setStep(3);
    } catch {
      setError("Couldn't save those items. They can be added later.");
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const printLabel = async () => {
    if (!workspace || !container) return;
    setBusy(true);
    try {
      const res = await api.labels.render(workspace.id, [container.id], "letter_sheet", true);
      await Linking.openURL(res.pdf_url);
      router.replace(`/container/${container.id}`);
    } catch {
      setError("Couldn't generate the label PDF. It stays in your print queue.");
    } finally {
      setBusy(false);
    }
  };

  const StepDots = () => (
    <View style={{ flexDirection: "row", gap: 6, marginBottom: spacing.md }}>
      {[1, 2, 3].map((s) => (
        <View
          key={s}
          style={{
            width: s === step ? 24 : 8, height: 8, borderRadius: 4,
            backgroundColor: s <= step ? t.primary : t.border,
          }}
        />
      ))}
    </View>
  );

  return (
    <Screen>
      <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
        <Ionicons name="close" size={26} color={t.textMuted} />
      </Pressable>
      <StepDots />

      {step === 1 && (
        <>
          <Title>New container</Title>
          <Subtitle>The number is assigned automatically.</Subtitle>

          <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600", marginBottom: 6 }}>Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
            {CONTAINER_TYPES.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => setType(opt.value)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, marginRight: 8,
                  backgroundColor: type === opt.value ? t.primary : t.card,
                  borderWidth: 1, borderColor: type === opt.value ? t.primary : t.border,
                }}
              >
                <Text style={{ color: type === opt.value ? t.primaryText : t.text, fontWeight: "600" }}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <TextField label="Title" value={title} onChangeText={setTitle} placeholder='e.g. "Fall Decorations"' />
          <TextField label="Category (optional)" value={category} onChangeText={setCategory} placeholder='e.g. "Seasonal"' />

          <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600", marginBottom: 6 }}>Location</Text>
          {locations.map((l) => (
            <Card
              key={l.id}
              onPress={() => setLocationId(l.id)}
              style={{ borderColor: locationId === l.id ? t.primary : t.border, borderWidth: locationId === l.id ? 2 : 1 }}
            >
              <Text style={{ color: t.text, fontSize: 15 }}>{l.path_text}</Text>
            </Card>
          ))}
          <TextField
            label={locations.length ? "Or create a new location" : "Create your first location"}
            value={newLocationName}
            onChangeText={(v) => { setNewLocationName(v); if (v) setLocationId(null); }}
            placeholder='e.g. "Garage"'
          />

          {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
          {sync.online
            ? <Button label="Create container" onPress={createContainer} loading={busy} />
            : (
              <>
                <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.sm }}>
                  You're offline. The container is saved on this device with a pending number and syncs automatically.
                </Text>
                <Button label="Save offline (Pending Number)" icon="cloud-offline-outline" onPress={createOffline} />
              </>
            )}
        </>
      )}

      {step === 2 && container && (
        <>
          <Title>{container.number_display}: {container.title}</Title>
          <Subtitle>Add what's inside — one item per line — or skip for now.</Subtitle>
          <TextField
            multiline
            value={lines}
            onChangeText={setLines}
            placeholder={"Fall pillows\nPumpkin garland\nCandle holders"}
          />
          {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
          <Button label={lines.trim() ? "Save items" : "Skip for now"} onPress={addContents} loading={busy} />
        </>
      )}

      {step === 3 && container && (
        <>
          <Title>Label time</Title>
          <Subtitle>
            Print the QR label for {container.number_display} now, or leave it in the print queue for later.
          </Subtitle>
          <View
            style={{
              backgroundColor: t.card, borderColor: t.border, borderWidth: 1, borderRadius: radius.md,
              padding: spacing.lg, alignItems: "center", marginBottom: spacing.md,
            }}
          >
            <Ionicons name="qr-code-outline" size={64} color={t.text} />
            <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", marginTop: spacing.sm }}>
              {container.number_display}
            </Text>
            <Text style={{ color: t.textMuted, fontSize: 14 }}>{container.title}</Text>
          </View>
          {error ? <Text style={{ color: t.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
          <Button label="Print label (PDF)" icon="print-outline" onPress={printLabel} loading={busy} />
          <Button
            label="Later — keep in print queue"
            kind="ghost"
            onPress={() => router.replace(`/container/${container.id}`)}
          />
        </>
      )}
    </Screen>
  );
}
