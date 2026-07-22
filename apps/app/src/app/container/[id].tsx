// Container detail: header, items with quick add, label + archive actions.

import React, { useCallback, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { containerTypeLabel, type Container, type Item } from "@findmybins/core";
import { ApiError, type DraftItem, type MediaInfo } from "@findmybins/api-client";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { offlineContainers, offlineItems, useSync } from "../../lib/offline";
import { addPhoto } from "../../lib/photos";
import { radius, spacing, useTheme } from "../../lib/theme";
import { Badge, Button, Card, EmptyState, ErrorView, LoadingView, Screen, SectionTitle, TextField } from "../../ui";

export default function ContainerDetail() {
  const t = useTheme();
  const { workspace } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [container, setContainer] = useState<Container | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [photos, setPhotos] = useState<MediaInfo[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [photoBusy, setPhotoBusy] = useState<"adding" | "analyzing" | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [newItem, setNewItem] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sync = useSync();
  const isLocal = String(id).startsWith("local:");

  const loadFromCache = useCallback(() => {
    if (!workspace || !id) return false;
    const cached = offlineContainers(workspace.id).find((c) => c.id === String(id));
    if (!cached) return false;
    setContainer({ ...cached, qr_link: null } as Container);
    setItems(offlineItems(workspace.id, String(id)).filter((i) => !i.deleted_at && !i.archived && i.state !== "draft") as Item[]);
    setDrafts([]);
    return true;
  }, [workspace?.id, id]);

  const load = useCallback(async () => {
    if (!workspace || !id) return;
    if (isLocal || !sync.online) {
      setError(null);
      if (!loadFromCache()) setError("This container isn't available offline.");
      return;
    }
    try {
      setError(null);
      const [c, i, d, m] = await Promise.all([
        api.containers.get(workspace.id, String(id)),
        api.items.list(workspace.id, { container_id: String(id) }),
        api.capture.listDrafts(workspace.id, String(id)).catch(() => ({ drafts: [] })),
        api.files.listMedia(workspace.id, "container", String(id)).catch(() => ({ media: [] })),
      ]);
      setContainer(c.container);
      setItems(i.items);
      setDrafts(d.drafts);
      setPhotos(m.media);
      if (m.media.length) {
        const { urls } = await api.files.getMediaUrls(workspace.id, m.media.map((p) => p.id), "thumb")
          .catch(() => ({ urls: {} as Record<string, string> }));
        setPhotoUrls(urls);
      } else {
        setPhotoUrls({});
      }
    } catch {
      if (!loadFromCache()) setError("This container isn't available.");
    }
  }, [workspace?.id, id, isLocal, sync.online, loadFromCache]);

  const capturePhoto = async (source: "camera" | "library") => {
    if (!workspace || !container) return;
    setPhotoBusy("adding");
    setPhotoNote(null);
    try {
      const media = await addPhoto(workspace.id, "container", container.id, source);
      if (media) await load();
    } catch (err) {
      setPhotoNote(err instanceof ApiError && err.code === "plan_limit"
        ? "Storage is full for this plan. Free up space or upgrade to add photos."
        : "Couldn't add that photo. Check your connection and try again.");
    } finally {
      setPhotoBusy(null);
    }
  };

  const analyzePhotos = async () => {
    if (!workspace || !container || !photos.length) return;
    setPhotoBusy("analyzing");
    setPhotoNote(null);
    try {
      const res = await api.capture.analyzePhotos(workspace.id, container.id, photos.slice(0, 5).map((p) => p.id));
      setPhotoNote(res.drafts.length
        ? `Found ${res.drafts.length} item${res.drafts.length === 1 ? "" : "s"} to review below.`
        : "No recognizable objects in these photos.");
      await load();
    } catch (err) {
      setPhotoNote(err instanceof ApiError && err.code === "ai_trial_exhausted"
        ? "Free-plan AI trial is used up. Upgrade for unlimited AI assistance."
        : err instanceof ApiError && err.code === "ai_throttled"
          ? "AI is paused for this hour (fair use). Manual entry still works."
          : "Analysis didn't complete. Nothing was saved.");
    } finally {
      setPhotoBusy(null);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!container) return <LoadingView />;

  const addItem = async () => {
    if (!workspace || !newItem.trim()) return;
    setBusy(true);
    try {
      if (isLocal || !sync.online) {
        // Offline: queue it; reference offline-created parents by client_uuid.
        const clientUuid = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        sync.enqueue(workspace.id, "create_item", {
          client_uuid: clientUuid,
          ...(isLocal ? { container_client_uuid: (container as any).client_uuid } : { container_id: container.id }),
          name: newItem.trim(),
        });
        setNewItem("");
        setItems((prev) => [...prev, {
          id: `local:${clientUuid}`, container_id: container.id, location_id: container.location_id,
          name: newItem.trim(), quantity: null, tags: [], state: "confirmed", origin: "manual", archived: false,
        } as Item]);
        return;
      }
      await api.items.create(workspace.id, container.id, { name: newItem.trim() });
      setNewItem("");
      await load();
    } catch { /* stays in the field for retry */ } finally {
      setBusy(false);
    }
  };

  const toggleArchived = async () => {
    if (!workspace) return;
    await api.containers.setArchived(workspace.id, container.id, !container.archived).catch(() => {});
    await load();
  };

  const printLabel = async () => {
    if (!workspace) return;
    setBusy(true);
    try {
      const res = await api.labels.render(workspace.id, [container.id], "letter_sheet", true);
      await Linking.openURL(res.pdf_url);
      await load();
    } catch { /* label stays queued */ } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
        <Ionicons name="arrow-back" size={24} color={t.textMuted} />
      </Pressable>

      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.xs }}>
        <View
          style={{
            backgroundColor: `${t.primary}18`, borderRadius: radius.sm,
            paddingHorizontal: 12, paddingVertical: 8, marginRight: spacing.sm,
          }}
        >
          <Text style={{ color: t.primary, fontSize: 18, fontWeight: "700" }}>
            {container.number_display ?? "…"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 22, fontWeight: "700" }}>{container.title}</Text>
          <Text style={{ color: t.textMuted, fontSize: 13 }}>
            {containerTypeLabel(container.container_type, container.custom_type_label)}
            {container.category ? ` · ${container.category}` : ""}
          </Text>
        </View>
        {container.archived && <Badge label="Archived" />}
      </View>

      {container.location_path && (
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.md }}>
          <Ionicons name="location-outline" size={16} color={t.accent} />
          <Text style={{ color: t.textMuted, fontSize: 14, marginLeft: 4 }}>{container.location_path}</Text>
        </View>
      )}

      <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            label={container.label_status === "printed" ? "Reprint label" : "Print label"}
            icon="print-outline" kind="secondary" onPress={printLabel} loading={busy}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label={container.archived ? "Restore" : "Archive"}
            icon={container.archived ? "refresh-outline" : "archive-outline"}
            kind="ghost" onPress={toggleArchived}
          />
        </View>
      </View>

      {!isLocal && sync.online && (
        <>
          <SectionTitle>Photos ({photos.length})</SectionTitle>
          {photos.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.sm }}>
              {photos.map((p) => (
                <View key={p.id} style={{ marginRight: spacing.sm }}>
                  <Image
                    source={{ uri: photoUrls[p.id] }}
                    style={{ width: 88, height: 88, borderRadius: radius.sm, backgroundColor: t.border }}
                    contentFit="cover"
                  />
                  <Pressable
                    onPress={async () => {
                      if (!workspace) return;
                      await api.files.deleteMedia(workspace.id, p.id).catch(() => {});
                      await load();
                    }}
                    style={{
                      position: "absolute", top: -6, right: -6, backgroundColor: t.card,
                      borderRadius: 999, borderWidth: 1, borderColor: t.border, padding: 3,
                    }}
                  >
                    <Ionicons name="close" size={12} color={t.textMuted} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          {!container.archived && (
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              {Platform.OS !== "web" && (
                <View style={{ flex: 1 }}>
                  <Button
                    label="Take photo" icon="camera-outline" kind="secondary"
                    onPress={() => capturePhoto("camera")}
                    loading={photoBusy === "adding"}
                  />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Button
                  label="Add photo" icon="images-outline" kind="secondary"
                  onPress={() => capturePhoto("library")}
                  loading={photoBusy === "adding"}
                />
              </View>
              {photos.length > 0 && (
                <View style={{ flex: 1 }}>
                  <Button
                    label="Analyze with AI" icon="sparkles-outline"
                    onPress={analyzePhotos}
                    loading={photoBusy === "analyzing"}
                  />
                </View>
              )}
            </View>
          )}
          {photoNote && (
            <Text style={{ color: t.textMuted, fontSize: 13, marginTop: spacing.xs, marginBottom: spacing.sm }}>
              {photoNote}
            </Text>
          )}
        </>
      )}

      {drafts.length > 0 && (
        <>
          <SectionTitle>AI drafts to review ({drafts.length})</SectionTitle>
          <Text style={{ color: t.textMuted, fontSize: 13, marginBottom: spacing.sm }}>
            Nothing is saved until you approve it.
          </Text>
          {drafts.map((d) => (
            <Card key={d.id}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{d.name}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 13 }}>
                    {d.quantity != null ? `Quantity: ${d.quantity}` : "Quantity not specified"}
                    {d.ai_confidence ? ` · ${d.ai_confidence} confidence` : ""}
                  </Text>
                </View>
                <Pressable
                  onPress={async () => {
                    if (!workspace) return;
                    await api.capture.confirmDrafts(workspace.id, [{ item_id: d.id }]).catch(() => {});
                    await load();
                  }}
                  style={{ backgroundColor: `${t.accent}22`, borderRadius: radius.sm, padding: 10, marginRight: 6 }}
                >
                  <Ionicons name="checkmark" size={18} color={t.accent} />
                </Pressable>
                <Pressable
                  onPress={async () => {
                    if (!workspace) return;
                    await api.capture.discardDrafts(workspace.id, [d.id]).catch(() => {});
                    await load();
                  }}
                  style={{ backgroundColor: `${t.danger}18`, borderRadius: radius.sm, padding: 10 }}
                >
                  <Ionicons name="close" size={18} color={t.danger} />
                </Pressable>
              </View>
            </Card>
          ))}
        </>
      )}

      <SectionTitle>Items ({items.length})</SectionTitle>
      {!container.archived && (
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <TextField
              value={newItem} onChangeText={setNewItem}
              placeholder="Add an item…" onSubmitEditing={addItem} returnKeyType="done"
            />
          </View>
          <Pressable
            onPress={addItem}
            disabled={!newItem.trim() || busy}
            style={{
              backgroundColor: t.primary, borderRadius: radius.sm, padding: 12,
              opacity: !newItem.trim() || busy ? 0.5 : 1,
            }}
          >
            <Ionicons name="add" size={22} color={t.primaryText} />
          </Pressable>
        </View>
      )}

      {items.length === 0 && (
        <EmptyState icon="file-tray-outline" title="Nothing listed yet" body="Add items so search can find them later." />
      )}

      {items.map((i) => (
        <Card key={i.id}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{i.name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 13 }}>
                {i.quantity != null ? `Quantity: ${i.quantity}` : "Quantity not specified"}
                {i.category ? ` · ${i.category}` : ""}
              </Text>
            </View>
            {i.state === "draft" && <Badge label="Draft" tone="warn" />}
            <Pressable
              onPress={async () => {
                if (!workspace) return;
                await api.items.remove(workspace.id, i.id).catch(() => {});
                await load();
              }}
              style={{ padding: 6, marginLeft: 6 }}
            >
              <Ionicons name="trash-outline" size={18} color={t.textMuted} />
            </Pressable>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
