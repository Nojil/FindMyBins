// api/search — keyword search with typo tolerance and synonyms.
// Authorization happens BEFORE retrieval: candidates are fetched only from the
// caller's workspace and filtered to accessible locations before scoring, so
// hidden matches can't influence results or counts. Search history is private
// to its author; no other role can read it and it never reaches activity logs.

import { createClientFromRequest } from "npm:@base44/sdk";
import { serveActions, badRequest, deny, ApiError, safeError } from "../../../shared/http.ts";
import { requireMember, accessibleLocationIds } from "../../../shared/authz.ts";
import { getSubscription, limitsFor, chargeAiAction } from "../../../shared/entitlements.ts";
import { formatNumber } from "../../../shared/numbering.ts";
import { buildSearchText } from "../../../shared/searchtext.ts";

const SYNONYMS: Record<string, string[]> = {
  christmas: ["xmas", "holiday"], xmas: ["christmas"],
  pillow: ["cushion"], cushion: ["pillow"],
  cable: ["cord", "wire"], cord: ["cable", "wire"], wire: ["cable", "cord"],
  couch: ["sofa"], sofa: ["couch"],
  photo: ["picture", "photograph"], picture: ["photo"],
  clothes: ["clothing", "apparel"], clothing: ["clothes"],
  decoration: ["decor", "ornament"], decor: ["decoration"], ornament: ["decoration"],
  toy: ["toys"], jacket: ["coat"], coat: ["jacket"],
};

function tokenize(text: string): string[] {
  return buildSearchText([text]).split(" ").filter((t) => t.length > 0);
}

function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
      rowMin = Math.min(rowMin, dp[j]);
    }
    if (rowMin > max) return false;
  }
  return dp[b.length] <= max;
}

type MatchKind = "exact" | "possible" | null;

/** Naive singularization so plural queries match singular records and synonyms. */
function forms(token: string): string[] {
  const out = [token];
  if (token.length > 3 && token.endsWith("es")) out.push(token.slice(0, -2));
  if (token.length > 2 && token.endsWith("s")) out.push(token.slice(0, -1));
  return out;
}

/** Match one query token against record tokens: exact > prefix > synonym > fuzzy. */
function matchToken(qt: string, recordTokens: string[]): { score: number; kind: MatchKind } {
  const qtForms = forms(qt);
  for (const f of qtForms) {
    if (recordTokens.includes(f)) return { score: 3, kind: "exact" };
    if (f.length >= 3 && recordTokens.some((rt) => rt.startsWith(f))) return { score: 2, kind: "exact" };
  }
  for (const f of qtForms) {
    for (const syn of SYNONYMS[f] ?? []) {
      if (recordTokens.includes(syn) || recordTokens.some((rt) => rt.startsWith(syn))) {
        return { score: 1.5, kind: "possible" };
      }
    }
  }
  if (qt.length >= 4) {
    const max = qt.length >= 7 ? 2 : 1;
    if (recordTokens.some((rt) => rt.length >= 3 && editDistanceAtMost(qt, rt, max))) {
      return { score: 1, kind: "possible" };
    }
  }
  return { score: 0, kind: null };
}

/** All query tokens must match in some form (AND semantics). */
function scoreRecord(queryTokens: string[], searchText: string): { score: number; kind: MatchKind } {
  const recordTokens = (searchText ?? "").split(" ");
  let total = 0;
  let kind: MatchKind = "exact";
  for (const qt of queryTokens) {
    const m = matchToken(qt, recordTokens);
    if (!m.kind) return { score: 0, kind: null };
    total += m.score;
    if (m.kind === "possible") kind = "possible";
  }
  return { score: total, kind };
}

serveActions({
  keyword: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const queryText = typeof payload.query === "string" ? payload.query.trim().slice(0, 200) : "";
    if (!queryText) throw badRequest("query required");
    const queryTokens = tokenize(queryText).slice(0, 10);
    if (!queryTokens.length) throw badRequest("query required");

    const accessible = await accessibleLocationIds(ctx);
    const includeArchived = payload.include_archived === true;

    // Optional scope filters (validated against accessibility below like everything else)
    const filterLocation = typeof payload.location_id === "string" ? payload.location_id : null;
    const filterCategory = typeof payload.category === "string" ? payload.category : null;
    const filterTag = typeof payload.tag === "string" ? payload.tag : null;

    const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const locById = new Map(locations.map((l: any) => [l.id, l]));
    const inScope = (locId: string) => {
      if (accessible !== null && !accessible.has(locId)) return false;
      if (filterLocation) {
        const loc = locById.get(locId);
        if (!loc) return false;
        if (loc.id !== filterLocation && !(loc.path_ids ?? []).includes(filterLocation)) return false;
      }
      return true;
    };

    const containers = await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 1000);
    const items = await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 2000);
    const containerById = new Map(containers.map((c: any) => [c.id, c]));

    const itemResults = [];
    for (const item of items) {
      if (item.deleted_at || item.state === "draft") continue;
      if (!includeArchived && item.archived) continue;
      if (!inScope(item.location_id)) continue;
      if (filterCategory && item.category !== filterCategory) continue;
      if (filterTag && !(item.tags ?? []).includes(filterTag)) continue;
      const { score, kind } = scoreRecord(queryTokens, item.search_text ?? buildSearchText([item.name]));
      if (!kind) continue;
      const container = containerById.get(item.container_id);
      itemResults.push({
        score, match: kind,
        item: { id: item.id, name: item.name, quantity: item.quantity ?? null, category: item.category, tags: item.tags ?? [], archived: !!item.archived },
        container: container
          ? { id: container.id, number_display: container.number ? formatNumber(container.number) : null, title: container.title, container_type: container.container_type }
          : null,
        location_path: locById.get(item.location_id)?.path_text ?? null,
      });
    }

    const containerResults = [];
    for (const c of containers) {
      if (!includeArchived && c.archived) continue;
      if (!inScope(c.location_id)) continue;
      if (filterCategory && c.category !== filterCategory) continue;
      if (filterTag && !(c.tags ?? []).includes(filterTag)) continue;
      const { score, kind } = scoreRecord(queryTokens, c.search_text ?? buildSearchText([c.title]));
      if (!kind) continue;
      containerResults.push({
        score, match: kind,
        container: { id: c.id, number_display: c.number ? formatNumber(c.number) : null, title: c.title, container_type: c.container_type, category: c.category, archived: !!c.archived },
        location_path: locById.get(c.location_id)?.path_text ?? null,
      });
    }

    itemResults.sort((a, b) => b.score - a.score);
    containerResults.sort((a, b) => b.score - a.score);

    // Save history only per the author's own preference; never in activity logs.
    if (payload.save_history !== false) {
      const profiles = await ctx.sr.entities.UserProfile.filter({ user_id: ctx.user.id });
      const profile = profiles[0];
      if (profile?.search_history_enabled !== false) {
        const days = profile?.search_history_expiry_days ?? 0;
        await ctx.sr.entities.SearchHistory.create({
          user_id: ctx.user.id,
          workspace_id: ctx.workspace.id,
          query_text: queryText,
          kind: "keyword",
          expires_at: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : undefined,
        }).catch((err: unknown) =>
          // Never log the error object: it echoes the request, which holds query_text.
          console.error("[search] history save failed:", safeError(err)));
      }
    }

    return {
      query: queryText,
      items: itemResults.slice(0, 100).map(({ score: _s, ...r }) => r),
      containers: containerResults.slice(0, 50).map(({ score: _s, ...r }) => r),
      exact_only: [...itemResults, ...containerResults].every((r) => r.match === "exact"),
    };
  },

  /**
   * Natural-language search (paid plans). Retrieval is permission-scoped
   * BEFORE the model sees anything; the model may only cite provided record
   * IDs, and citations are re-validated server-side after the call.
   */
  natural: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const queryText = typeof payload.query === "string" ? payload.query.trim().slice(0, 300) : "";
    if (!queryText) throw badRequest("query required");

    const sub = await getSubscription(ctx.sr, ctx.workspace.id);
    if (!limitsFor(sub).natural_language_search) {
      throw new ApiError(402, "plan_limit", "natural_language_search");
    }
    await chargeAiAction(ctx.sr, ctx.workspace.id);

    const accessible = await accessibleLocationIds(ctx);
    const locations = await ctx.sr.entities.Location.filter({ workspace_id: ctx.workspace.id });
    const locById = new Map(locations.map((l: any) => [l.id, l]));
    const inScope = (locId: string) => accessible === null || accessible.has(locId);

    const containers = (await ctx.sr.entities.Container.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 300))
      .filter((c: any) => !c.archived && inScope(c.location_id));
    const containerById = new Map(containers.map((c: any) => [c.id, c]));
    const items = (await ctx.sr.entities.Item.filter({ workspace_id: ctx.workspace.id }, "-updated_date", 800))
      .filter((i: any) => !i.deleted_at && !i.archived && i.state === "confirmed" && inScope(i.location_id));

    const compactItems = items.slice(0, 400).map((i: any) => ({
      id: i.id, name: i.name, qty: i.quantity ?? null, category: i.category ?? null,
      container: containerById.get(i.container_id)
        ? `${formatNumber(containerById.get(i.container_id).number)} ${containerById.get(i.container_id).title}`
        : null,
      location: locById.get(i.location_id)?.path_text ?? null,
    }));
    const compactContainers = containers.slice(0, 150).map((c: any) => ({
      id: c.id, number: c.number ? formatNumber(c.number) : null, title: c.title,
      category: c.category ?? null, location: locById.get(c.location_id)?.path_text ?? null,
    }));

    const result: any = await ctx.sr.integrations.Core.InvokeLLM({
      prompt:
        "You answer questions about a user's physical storage inventory using ONLY the records provided below. " +
        "Rules: never invent items, quantities, containers, or locations; a missing qty means 'not specified', never 1; " +
        "cite the ids of every record your answer relies on; mark each citation exact or possible; " +
        "if the records can't answer reliably, say so and set no_reliable_result true.\n\n" +
        `Question: ${queryText}\n\nITEMS:\n${JSON.stringify(compactItems)}\n\nCONTAINERS:\n${JSON.stringify(compactContainers)}`,
      response_json_schema: {
        type: "object",
        properties: {
          answer: { type: "string" },
          no_reliable_result: { type: "boolean" },
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                kind: { type: "string", enum: ["item", "container"] },
                match: { type: "string", enum: ["exact", "possible"] },
              },
              required: ["id", "kind", "match"],
            },
          },
        },
        required: ["answer", "no_reliable_result", "citations"],
      },
    });

    // Hard guarantee: only records from the scoped candidate set can be returned.
    const itemById = new Map(items.map((i: any) => [i.id, i]));
    const cited = (Array.isArray(result?.citations) ? result.citations : []).slice(0, 30);
    const matches = [];
    for (const c of cited) {
      if (c.kind === "item" && itemById.has(c.id)) {
        const i = itemById.get(c.id);
        const cont = containerById.get(i.container_id);
        matches.push({
          kind: "item", match: c.match === "exact" ? "exact" : "possible",
          item: { id: i.id, name: i.name, quantity: i.quantity ?? null, category: i.category, tags: i.tags ?? [] },
          container: cont
            ? { id: cont.id, number_display: cont.number ? formatNumber(cont.number) : null, title: cont.title, container_type: cont.container_type }
            : null,
          location_path: locById.get(i.location_id)?.path_text ?? null,
        });
      } else if (c.kind === "container" && containerById.has(c.id)) {
        const cont = containerById.get(c.id);
        matches.push({
          kind: "container", match: c.match === "exact" ? "exact" : "possible",
          container: { id: cont.id, number_display: cont.number ? formatNumber(cont.number) : null, title: cont.title, container_type: cont.container_type },
          location_path: locById.get(cont.location_id)?.path_text ?? null,
        });
      }
    }

    if (payload.save_history !== false) {
      const profiles = await ctx.sr.entities.UserProfile.filter({ user_id: ctx.user.id });
      const profile = profiles[0];
      if (profile?.search_history_enabled !== false) {
        const days = profile?.search_history_expiry_days ?? 0;
        await ctx.sr.entities.SearchHistory.create({
          user_id: ctx.user.id, workspace_id: ctx.workspace.id, query_text: queryText, kind: "natural",
          expires_at: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : undefined,
        }).catch(() => {});
      }
    }

    return {
      query: queryText,
      answer: typeof result?.answer === "string" ? result.answer : "",
      no_reliable_result: result?.no_reliable_result === true || matches.length === 0,
      matches,
    };
  },

  history_list: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const entries = await ctx.sr.entities.SearchHistory.filter(
      { user_id: ctx.user.id, workspace_id: ctx.workspace.id }, "-created_date", 50,
    );
    const now = new Date();
    return {
      history: entries
        .filter((e: any) => !e.expires_at || new Date(e.expires_at) > now)
        .map((e: any) => ({ id: e.id, query_text: e.query_text, kind: e.kind, created_date: e.created_date })),
    };
  },

  history_delete: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const entry = await ctx.sr.entities.SearchHistory.get(payload.entry_id).catch(() => null);
    // Only the author can touch their entries — including admins and the owner.
    if (!entry || entry.user_id !== ctx.user.id) throw deny();
    await ctx.sr.entities.SearchHistory.delete(entry.id);
    return { deleted: true };
  },

  history_clear: async (payload, req) => {
    const base44 = createClientFromRequest(req);
    const ctx = await requireMember(base44, payload.workspace_id);
    const entries = await ctx.sr.entities.SearchHistory.filter({
      user_id: ctx.user.id, workspace_id: ctx.workspace.id,
    });
    for (const e of entries) await ctx.sr.entities.SearchHistory.delete(e.id);
    return { cleared: entries.length };
  },
});
