// Photo capture pipeline: pick/take a photo → generate size variants
// client-side (keeps heavy image work off the 5-minute backend functions and
// stays offline-friendly later) → upload each variant to PRIVATE storage →
// register the asset so the server enforces authorization and storage quota.

import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { APP_ID, SERVER_URL } from "@findmybins/core";
import { api } from "./api";
import type { MediaInfo } from "@findmybins/api-client";

const VARIANT_WIDTHS = { thumb: 240, medium: 800, full: 1600 } as const;
type VariantName = keyof typeof VARIANT_WIDTHS;

export async function pickPhoto(source: "camera" | "library"): Promise<string | null> {
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
    const res = await ImagePicker.launchCameraAsync({ quality: 0.92 });
    return res.canceled ? null : res.assets[0]?.uri ?? null;
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.92 });
  return res.canceled ? null : res.assets[0]?.uri ?? null;
}

async function resizeTo(uri: string, width: number): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width } }],
    { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG },
  );
  return result.uri;
}

async function uploadVariant(uri: string, name: string): Promise<{ file_uri: string; bytes: number }> {
  if (Platform.OS === "web") {
    // Web has a real File, which the SDK's UploadPrivateFile handles correctly.
    const blob = await (await fetch(uri)).blob();
    const file = new File([blob], name, { type: "image/jpeg" });
    const res: any = await api.raw.integrations.Core.UploadPrivateFile({ file });
    const file_uri = res?.file_uri ?? res?.data?.file_uri;
    if (typeof file_uri !== "string") throw new Error("upload failed");
    return { file_uri, bytes: blob.size };
  }
  // Native: stream the file to private storage with expo-file-system's native
  // multipart upload. This deliberately avoids fetch/FormData. On device the
  // global fetch is Expo's Winter fetch, which can't read a React Native Blob
  // (its FileReader has no readAsArrayBuffer) and rejects the legacy
  // { uri, name, type } descriptor ("Unsupported FormDataPart implementation"),
  // while the SDK JSON-stringifies that descriptor into a dict the backend
  // rejects. File.upload() reads the file from disk and sends a real multipart
  // part (default field name "file", which is what the endpoint expects).
  const FS = require("expo-file-system");
  const token = await api.auth.getToken();
  const f = new FS.File(uri);
  const result = await f.upload(
    `${SERVER_URL}/api/apps/${APP_ID}/integration-endpoints/Core/UploadPrivateFile`,
    {
      httpMethod: "POST",
      uploadType: FS.UploadType.MULTIPART,
      fieldName: "file",
      mimeType: "image/jpeg",
      headers: token
        ? { Authorization: `Bearer ${token}`, "X-App-Id": APP_ID }
        : { "X-App-Id": APP_ID },
    },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`upload ${result.status}: ${String(result.body ?? "").slice(0, 160)}`);
  }
  let fileUri: unknown;
  try { fileUri = JSON.parse(result.body)?.file_uri ?? JSON.parse(result.body)?.data?.file_uri; }
  catch { /* non-JSON body falls through to the guard below */ }
  if (typeof fileUri !== "string") throw new Error("upload: no file_uri in response");
  return { file_uri: fileUri, bytes: typeof f.size === "number" ? f.size : 0 };
}

/** Full pipeline. Returns the registered media record. */
export async function addPhoto(
  workspaceId: string,
  ownerType: "container" | "item",
  ownerId: string,
  source: "camera" | "library",
): Promise<MediaInfo | null> {
  const original = await pickPhoto(source);
  if (!original) return null;

  const fileUris: Partial<Record<VariantName, string>> = {};
  let bytesTotal = 0;
  for (const variant of Object.keys(VARIANT_WIDTHS) as VariantName[]) {
    const resized = await resizeTo(original, VARIANT_WIDTHS[variant]);
    const uploaded = await uploadVariant(resized, `${variant}.jpg`);
    fileUris[variant] = uploaded.file_uri;
    bytesTotal += uploaded.bytes;
  }

  const { media } = await api.files.registerMedia(workspaceId, {
    owner_type: ownerType,
    owner_id: ownerId,
    file_uris: fileUris,
    bytes_total: Math.max(bytesTotal, 1),
    content_type: "image/jpeg",
  });
  return media;
}
