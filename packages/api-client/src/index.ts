// Typed client for the FindMyBins backend functions. Platform-agnostic:
// callers supply token storage (SecureStore on native, localStorage on web).

import { createClient } from "@base44/sdk";
import {
  APP_ID, AUTH_BASE_URL,
  type Container, type DashboardOverview, type Item, type LocationNode, type OAuthProvider,
  type Profile, type QrResolution, type SearchContainerResult, type SearchItemResult,
  type WorkspaceSummary, type WorkspaceType, type ContainerType,
} from "@findmybins/core";

export interface TokenStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export interface DraftItem {
  id: string;
  container_id: string;
  name: string;
  quantity: number | null;
  category?: string;
  tags: string[];
  description?: string;
  ai_confidence?: "high" | "medium" | "low";
  state: "draft" | "confirmed";
  origin: string;
  capture_session_id?: string;
}

export interface ActivityEvent {
  id: string;
  action: string;
  actor_email: string | null;
  target_type: string | null;
  target_label: string | null;
  metadata: Record<string, unknown>;
  critical: boolean;
  created_date: string;
}

export interface RecoveryList {
  items: Array<{ id: string; name: string; container_id: string; deleted_at: string; purge_after: string }>;
  media: Array<{ id: string; owner_type: string; owner_id: string; bytes_total: number; deleted_at: string; purge_after: string }>;
  attachments: Array<{ id: string; file_name: string; owner_type: string; owner_id: string; bytes: number; deleted_at: string; purge_after: string }>;
  note: string;
}

export interface BillingSnapshot {
  plan: "free" | "household" | "business";
  stored_plan: string;
  status: string;
  trial_type: string | null;
  trial_ends_at: string | null;
  billing_interval: "monthly" | "annual" | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  payment_provider: string | null;
  seats: { included: number; extra: number } | null;
  storage: { bytes_used: number; bytes_limit: number };
  ai_trial: { used: number; total: number } | null;
  pricing: {
    household: { monthly_usd: number; annual_usd: number };
    business: { monthly_usd: number; annual_usd: number; extra_seat_monthly_usd: number; extra_seat_annual_usd: number; seats_included: number };
    trial_days: number;
  };
  providers: { stripe_configured: boolean; ios_iap_configured: boolean; android_iap_configured: boolean };
}

export interface MediaInfo {
  id: string;
  owner_type: string;
  owner_id: string;
  content_type: string;
  bytes_total: number;
  variants: string[];
  deleted_at: string | null;
  created_date?: string;
}

export interface NaturalSearchResult {
  query: string;
  answer: string;
  no_reliable_result: boolean;
  matches: Array<{
    kind: "item" | "container";
    match: "exact" | "possible";
    item?: { id: string; name: string; quantity: number | null; category?: string; tags: string[] };
    container: { id: string; number_display: string | null; title: string; container_type: string } | null;
    location_path: string | null;
  }>;
}

const TOKEN_KEY = "fmb_token";

export function createApi(storage: TokenStorage) {
  const base44 = createClient({ appId: APP_ID });

  async function invoke<T>(fn: string, action: string, payload?: Record<string, unknown>): Promise<T> {
    try {
      const res = await base44.functions.invoke(fn, { action, payload: payload ?? {} });
      const body = res?.data;
      if (body?.ok === false) throw new ApiError(500, body.error ?? "internal", body.message);
      return (body?.data ?? body) as T;
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      const status = err?.response?.status ?? 0;
      const data = err?.response?.data;
      throw new ApiError(status, data?.error ?? "network", data?.message ?? err?.message);
    }
  }

  return {
    raw: base44,
    invoke,

    auth: {
      async restore(): Promise<boolean> {
        let token = await storage.get(TOKEN_KEY);
        if (!token) {
          // Web only: after an OAuth redirect the SDK auto-captures the
          // ?access_token into its own localStorage key — mirror it into ours.
          try {
            const sdkToken = (globalThis as any).localStorage?.getItem("base44_access_token") ?? null;
            if (sdkToken) {
              token = sdkToken;
              await storage.set(TOKEN_KEY, sdkToken);
            }
          } catch { /* not a browser */ }
        }
        if (!token) return false;
        base44.auth.setToken(token, false);
        return true;
      },
      /**
       * Start-of-flow URL for provider OAuth. `fromUrl` is where Base44
       * redirects back to (with ?access_token=…) after the provider round-trip.
       */
      providerLoginUrl(provider: OAuthProvider, fromUrl: string): string {
        const providerPath = provider === "google" ? "" : `/${provider}`;
        return `${AUTH_BASE_URL}/api/apps/auth${providerPath}/login` +
          `?app_id=${APP_ID}&from_url=${encodeURIComponent(fromUrl)}`;
      },
      /** Adopt a token obtained out-of-band (native OAuth session round-trip). */
      async adoptToken(token: string): Promise<void> {
        base44.auth.setToken(token, false);
        await storage.set(TOKEN_KEY, token);
      },
      /**
       * Claim a token the browser stored under `handoffId` after native OAuth.
       * Unauthenticated by design — the app has no session yet. Returns "pending"
       * while the user is still at the provider, "ready" with the token once,
       * or "expired".
       */
      async claimHandoff(handoffId: string): Promise<"pending" | "ready" | "expired"> {
        const res: any = await base44.functions.invoke("api/auth-handoff", {
          action: "claim",
          payload: { handoff_id: handoffId },
        });
        const body = res?.data?.data ?? res?.data ?? {};
        if (body.status === "ready" && body.access_token) {
          await this.adoptToken(body.access_token);
          return "ready";
        }
        return body.status === "expired" ? "expired" : "pending";
      },
      async signIn(email: string, password: string): Promise<void> {
        const res: any = await base44.auth.loginViaEmailPassword(email, password);
        const token = res?.access_token ?? res?.data?.access_token;
        if (!token) throw new ApiError(401, "login_failed");
        base44.auth.setToken(token, false);
        await storage.set(TOKEN_KEY, token);
      },
      async register(email: string, password: string): Promise<void> {
        await base44.auth.register({ email, password });
      },
      async verifyOtp(email: string, otpCode: string): Promise<void> {
        const res: any = await base44.auth.verifyOtp({ email, otpCode });
        const token = res?.access_token ?? res?.data?.access_token;
        if (token) {
          base44.auth.setToken(token, false);
          await storage.set(TOKEN_KEY, token);
        }
      },
      async resendOtp(email: string): Promise<void> {
        await base44.auth.resendOtp(email);
      },
      async signOut(): Promise<void> {
        await storage.remove(TOKEN_KEY);
        try { base44.auth.setToken("", false); } catch { /* token clear is best-effort */ }
      },
    },

    workspaces: {
      bootstrap: () =>
        invoke<{ profile: Profile; terms_version: string; workspaces: WorkspaceSummary[] }>(
          "api/workspaces", "bootstrap"),
      updateProfile: (patch: Record<string, unknown>) =>
        invoke<{ profile: Profile }>("api/workspaces", "update_profile", patch),
      create: (name: string, workspace_type: WorkspaceType) =>
        invoke<{ workspace: WorkspaceSummary }>("api/workspaces", "create_workspace", { name, workspace_type }),
      get: (workspace_id: string) =>
        invoke<{ workspace: WorkspaceSummary & Record<string, unknown> }>(
          "api/workspaces", "get_workspace", { workspace_id }),
      startTrial: (workspace_id: string) =>
        invoke<{ plan: string; status: string; trial_ends_at: string }>(
          "api/workspaces", "start_trial", { workspace_id }),
    },

    locations: {
      list: (workspace_id: string, include_archived = false) =>
        invoke<{ locations: LocationNode[] }>("api/locations", "list_locations", { workspace_id, include_archived }),
      create: (workspace_id: string, name: string, parent_id?: string) =>
        invoke<{ location: LocationNode }>("api/locations", "create_location", { workspace_id, name, parent_id }),
    },

    containers: {
      list: (workspace_id: string, opts: { location_id?: string; archived_filter?: boolean } = {}) =>
        invoke<{ containers: Container[] }>("api/containers", "list_containers", { workspace_id, ...opts }),
      get: (workspace_id: string, container_id: string) =>
        invoke<{ container: Container }>("api/containers", "get_container", { workspace_id, container_id }),
      create: (workspace_id: string, data: {
        location_id: string; title: string; container_type: ContainerType;
        category?: string; description?: string; custom_type_label?: string;
      }) =>
        invoke<{ container: Container }>("api/containers", "create_container", { workspace_id, ...data }),
      update: (workspace_id: string, container_id: string, patch: Record<string, unknown>) =>
        invoke<{ container: Container }>("api/containers", "update_container", { workspace_id, container_id, patch }),
      setArchived: (workspace_id: string, container_id: string, archived: boolean) =>
        invoke<{ archived: boolean }>("api/containers", "set_archived", { workspace_id, container_id, archived }),
      move: (workspace_id: string, container_id: string, new_location_id: string) =>
        invoke<{ moved: boolean; access_warning: string | null }>(
          "api/containers", "move_container", { workspace_id, container_id, new_location_id }),
      lookupByNumber: (workspace_id: string, number: number) =>
        invoke<{ container: Container }>("api/containers", "lookup_by_number", { workspace_id, number }),
    },

    items: {
      list: (workspace_id: string, opts: { container_id?: string; location_id?: string } = {}) =>
        invoke<{ items: Item[] }>("api/items", "list_items", { workspace_id, ...opts }),
      create: (workspace_id: string, container_id: string, data: Record<string, unknown>) =>
        invoke<{ item: Item }>("api/items", "create_item", { workspace_id, container_id, ...data }),
      quickAdd: (workspace_id: string, container_id: string, lines: string) =>
        invoke<{ items: Item[] }>("api/items", "quick_add", { workspace_id, container_id, lines }),
      update: (workspace_id: string, item_id: string, patch: Record<string, unknown>) =>
        invoke<{ item: Item }>("api/items", "update_item", { workspace_id, item_id, patch }),
      remove: (workspace_id: string, item_id: string) =>
        invoke<{ deleted: boolean }>("api/items", "delete_item", { workspace_id, item_id }),
    },

    search: {
      keyword: (workspace_id: string, query: string, opts: Record<string, unknown> = {}) =>
        invoke<{ query: string; items: SearchItemResult[]; containers: SearchContainerResult[]; exact_only: boolean }>(
          "api/search", "keyword", { workspace_id, query, ...opts }),
      natural: (workspace_id: string, query: string) =>
        invoke<NaturalSearchResult>("api/search", "natural", { workspace_id, query }),
      history: (workspace_id: string) =>
        invoke<{ history: Array<{ id: string; query_text: string; created_date: string }> }>(
          "api/search", "history_list", { workspace_id }),
      historyClear: (workspace_id: string) =>
        invoke<{ cleared: number }>("api/search", "history_clear", { workspace_id }),
    },

    qr: {
      resolve: (qr_token: string) => invoke<QrResolution>("api/qr", "resolve", { qr_token }),
    },

    capture: {
      analyzePhotos: (workspace_id: string, container_id: string, media_ids: string[]) =>
        invoke<{ session_id: string; status: string; photo_note: string | null; drafts: DraftItem[] }>(
          "api/capture", "analyze_photos", { workspace_id, container_id, media_ids }),
      listDrafts: (workspace_id: string, container_id?: string) =>
        invoke<{ drafts: DraftItem[] }>("api/capture", "list_drafts", { workspace_id, container_id }),
      confirmDrafts: (workspace_id: string, items: Array<{ item_id: string; patch?: Record<string, unknown> }>) =>
        invoke<{ confirmed: DraftItem[] }>("api/capture", "confirm_drafts", { workspace_id, items }),
      discardDrafts: (workspace_id: string, item_ids: string[]) =>
        invoke<{ discarded: number }>("api/capture", "discard_drafts", { workspace_id, item_ids }),
      barcodeLookup: (workspace_id: string, barcode: string) =>
        invoke<{ barcode: string; suggestion: { name: string; brand: string; model: string; description: string; category: string } | null }>(
          "api/capture", "barcode_lookup", { workspace_id, barcode }),
      barcodeAdd: (workspace_id: string, container_id: string, barcode: string, fields: Record<string, unknown>) =>
        invoke<{ item: DraftItem }>("api/capture", "barcode_add", { workspace_id, container_id, barcode, fields }),
    },

    labels: {
      render: (workspace_id: string, container_ids: string[], format = "letter_sheet", mark_printed = false) =>
        invoke<{ pdf_url: string; label_count: number; pages: number }>(
          "api/labels", "render_labels", { workspace_id, container_ids, format, mark_printed }),
      queue: (workspace_id: string) =>
        invoke<{ queue: Array<{ id: string; number_display: string | null; title: string; label_status: string }> }>(
          "api/labels", "print_queue", { workspace_id }),
    },

    files: {
      registerMedia: (workspace_id: string, data: {
        owner_type: "container" | "item"; owner_id: string;
        file_uris: Partial<Record<"thumb" | "medium" | "full" | "original", string>>;
        bytes_total: number; content_type: string; client_uuid?: string;
      }) => invoke<{ media: MediaInfo }>("api/files", "register_media", { workspace_id, ...data }),
      listMedia: (workspace_id: string, owner_type: "container" | "item", owner_id: string) =>
        invoke<{ media: MediaInfo[] }>("api/files", "list_media", { workspace_id, owner_type, owner_id }),
      getMediaUrls: (workspace_id: string, media_ids: string[], variant: "thumb" | "medium" | "full" = "medium") =>
        invoke<{ urls: Record<string, string>; expires_in: number }>(
          "api/files", "get_media_urls", { workspace_id, media_ids, variant }),
      deleteMedia: (workspace_id: string, media_id: string) =>
        invoke<{ deleted: boolean }>("api/files", "delete_media", { workspace_id, media_id }),
    },

    billing: {
      get: (workspace_id: string) => invoke<BillingSnapshot>("api/billing", "get_billing", { workspace_id }),
      startCheckout: (workspace_id: string, plan: "household" | "business", interval: "monthly" | "annual", seats_extra?: number) =>
        invoke<{ configured: boolean; checkout_url?: string; message?: string }>(
          "api/billing", "start_checkout", { workspace_id, plan, interval, seats_extra }),
      openPortal: (workspace_id: string) =>
        invoke<{ configured: boolean; portal_url?: string; message?: string }>(
          "api/billing", "open_portal", { workspace_id }),
      applyIapReceipt: (workspace_id: string, platform: "ios" | "android", product_id: string, receipt: string) =>
        invoke<{ configured: boolean; plan?: string; status?: string; message?: string }>(
          "api/billing", "apply_iap_receipt", { workspace_id, platform, product_id, receipt }),
    },

    workspacesExtra: {
      startTrial: (workspace_id: string) =>
        invoke<{ plan: string; status: string; trial_ends_at: string }>(
          "api/workspaces", "start_trial", { workspace_id }),
      transferOwnership: (workspace_id: string, member_id: string, confirm_name: string) =>
        invoke<{ transferred: boolean; new_owner_user_id: string }>(
          "api/workspaces", "transfer_ownership", { workspace_id, member_id, confirm_name }),
      requestDeletion: (workspace_id: string, confirm_name: string) =>
        invoke<{ status: string; effective_at: string }>(
          "api/workspaces", "request_workspace_deletion", { workspace_id, confirm_name }),
      cancelDeletion: (workspace_id: string) =>
        invoke<{ status: string }>("api/workspaces", "cancel_workspace_deletion", { workspace_id }),
      accountDeletionStatus: () =>
        invoke<{ can_delete: boolean; owned_workspaces: Array<{ workspace_id: string; name: string; status: string }> }>(
          "api/workspaces", "account_deletion_status", {}),
      deleteAccount: () => invoke<{ deleted: boolean }>("api/workspaces", "delete_account", { confirm: "DELETE" }),
    },

    members: {
      list: (workspace_id: string) =>
        invoke<{ members: Array<{ id: string; user_email: string; member_role: string; status: string; grants: Array<{ location_id: string; grant_role: string }> }> }>(
          "api/members", "list_members", { workspace_id }),
      createInvitation: (workspace_id: string, kind: "email" | "link" | "code", invite_role: string, opts: Record<string, unknown> = {}) =>
        invoke<{ invitation_id: string; link?: string; code?: string; email_sent: boolean; expires_at: string }>(
          "api/members", "create_invitation", { workspace_id, kind, invite_role, ...opts }),
      removeMember: (workspace_id: string, member_id: string) =>
        invoke<{ removed: boolean }>("api/members", "remove_member", { workspace_id, member_id }),
      updateRole: (workspace_id: string, member_id: string, member_role: string) =>
        invoke<{ member: unknown }>("api/members", "update_member_role", { workspace_id, member_id, member_role }),
    },

    activity: {
      list: (workspace_id: string, limit = 50) =>
        invoke<{ retention_days: number; events: ActivityEvent[] }>("api/activity", "list", { workspace_id, limit }),
      recoveryList: (workspace_id: string) =>
        invoke<RecoveryList>("api/activity", "recovery_list", { workspace_id }),
      restoreItem: (workspace_id: string, item_id: string) =>
        invoke<{ item: Item }>("api/items", "restore_deleted", { workspace_id, item_id }),
      restoreMedia: (workspace_id: string, media_id: string) =>
        invoke<{ restored: boolean }>("api/files", "restore_media", { workspace_id, media_id }),
    },

    dashboard: {
      overview: (workspace_id: string) =>
        invoke<DashboardOverview>("api/dashboard", "overview", { workspace_id }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
