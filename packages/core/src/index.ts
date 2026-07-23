// Shared domain types and constants for every FindMyBins client.

export const APP_ID = "6a5fd45e9129f5171ccbb963";
export const QR_LINK_BASE = "https://findmybins.com/q/";
/** Deployed web app (will move to findmybins.com). */
export const WEB_APP_URL = "https://find-my-bins-1ccbb963.base44.app";
/** Base44 OAuth start endpoints live here (the static app domain does not proxy /api). */
export const AUTH_BASE_URL = "https://app.base44.com";
/** Base44 API host the SDK talks to (function endpoints, etc.). */
export const SERVER_URL = "https://base44.app";

export type OAuthProvider = "google" | "apple";

export type WorkspaceType = "household" | "business" | "organization";
export type MemberRole = "owner" | "admin" | "manager" | "contributor" | "viewer" | "billing_admin";
export type Plan = "free" | "household" | "business";
export type LabelStatus = "not_printed" | "queued" | "printed";

export const CONTAINER_TYPES = [
  { value: "bin", label: "Bin" },
  { value: "tote", label: "Tote" },
  { value: "box", label: "Box" },
  { value: "crate", label: "Crate" },
  { value: "bag", label: "Bag" },
  { value: "drawer", label: "Drawer" },
  { value: "cabinet", label: "Cabinet" },
  { value: "trunk", label: "Trunk" },
  { value: "case", label: "Case" },
  { value: "bucket", label: "Bucket" },
  { value: "file_box", label: "File box" },
  { value: "custom", label: "Custom" },
] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number]["value"];

export interface Profile {
  id: string;
  display_name: string | null;
  theme: "system" | "light" | "dark";
  is_18_or_over: boolean;
  terms_accepted_at: string | null;
  search_history_enabled: boolean;
  analytics_opt_out: boolean;
  default_workspace_id: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  workspace_type: WorkspaceType;
  status: string;
  my_role: MemberRole;
  plan: Plan;
}

export interface LocationNode {
  id: string;
  parent_id: string | null;
  name: string;
  level: number;
  path_ids: string[];
  path_text: string;
  archived: boolean;
}

export interface Container {
  id: string;
  location_id: string;
  location_path?: string;
  number: number | null;
  number_display: string | null;
  pending_number: boolean;
  container_type: ContainerType;
  custom_type_label?: string;
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  notes?: string;
  label_status: LabelStatus;
  archived: boolean;
  qr_link: string | null;
  created_date?: string;
  updated_date?: string;
}

export interface Item {
  id: string;
  container_id: string;
  location_id: string;
  name: string;
  quantity: number | null;
  description?: string;
  category?: string;
  tags: string[];
  notes?: string;
  state: "draft" | "confirmed";
  origin: string;
  archived: boolean;
  [key: string]: unknown;
}

export interface SearchItemResult {
  match: "exact" | "possible";
  item: { id: string; name: string; quantity: number | null; category?: string; tags: string[]; archived: boolean };
  container: { id: string; number_display: string | null; title: string; container_type: string } | null;
  location_path: string | null;
}

export interface SearchContainerResult {
  match: "exact" | "possible";
  container: { id: string; number_display: string | null; title: string; container_type: string; category?: string; archived: boolean };
  location_path: string | null;
}

export interface QrResolution {
  state: "active" | "archived";
  workspace: { id: string; name: string; workspace_type: WorkspaceType };
  container: {
    id: string; number_display: string | null; container_type: string; custom_type_label?: string;
    title: string; description?: string; category?: string; tags: string[]; notes?: string;
    location_id: string; location_path: string;
  };
  my_role: MemberRole;
  items?: Array<{ id: string; name: string; quantity: number | null; category?: string; tags: string[] }>;
  media_ids?: string[];
  archived_at?: string;
  can_restore?: boolean;
}

export interface DashboardOverview {
  workspace: { id: string; name: string; workspace_type: WorkspaceType; my_role: MemberRole; plan: Plan };
  totals: { containers: number; items: number; locations: number };
  unprinted_labels: number;
  pending_ai_drafts: number;
  recent_containers: Array<{
    id: string; number_display: string | null; title: string;
    container_type: string; location_path: string | null; updated_date: string;
  }>;
  locations: Array<{ id: string; name: string; path_text: string; container_count: number }>;
  storage: { bytes_used: number; bytes_limit: number };
  recent_activity?: Array<{ action: string; actor_email: string; target_label?: string; created_date: string }>;
  member_count?: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function containerTypeLabel(type: string, customLabel?: string): string {
  if (type === "custom" && customLabel) return customLabel;
  return CONTAINER_TYPES.find((t) => t.value === type)?.label ?? type;
}
