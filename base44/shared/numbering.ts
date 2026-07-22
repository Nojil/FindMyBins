// Workspace-wide container numbering without platform unique constraints or
// atomic counters: append-only NumberReservation records with settle-and-verify
// collision detection. Winning reservations are permanent — numbers of archived
// and permanently deleted containers stay retired forever. Only a losing
// duplicate (never a real allocation) is ever removed.
//
// Why the delays: freshly created records are not immediately visible to
// concurrent readers, so an instant duplicate check can miss a rival claim
// (verified empirically). Two verification rounds after visibility settles make
// the deterministic winner rule reliable.

import { ApiError } from "./http.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic tie-break: the lexicographically lowest record id keeps the number. */
function winnerOf(dupes: Array<{ id: string }>): string {
  return dupes.map((d) => d.id).sort()[0];
}

export async function allocateNumber(
  sr: any,
  workspaceId: string,
  containerId: string,
  reason: "create" | "import" = "create",
): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const top = await sr.entities.NumberReservation.filter({ workspace_id: workspaceId }, "-number", 1);
    const next = (top[0]?.number ?? 0) + 1;

    const mine = await sr.entities.NumberReservation.create({
      workspace_id: workspaceId,
      number: next,
      container_id: containerId,
      reason,
    });

    let lost = false;
    for (const delay of [150, 450]) {
      await sleep(delay);
      const dupes = await sr.entities.NumberReservation.filter({ workspace_id: workspaceId, number: next });
      if (dupes.length > 1 && winnerOf(dupes) !== mine.id) {
        lost = true;
        break;
      }
    }
    if (!lost) return next;

    await sr.entities.NumberReservation.delete(mine.id);
    // Jitter spreads rival retriers so they stop colliding on the same next number.
    await sleep(50 + Math.floor(Math.random() * 250));
  }
  throw new ApiError(503, "number_allocation_failed");
}

/**
 * Bulk allocation for imports: claim a contiguous block with ONE settle round
 * instead of per-number delays. Numbers that lose their race are re-allocated
 * individually. Returns exactly `count` unique numbers (order preserved).
 */
export async function allocateNumberBlock(
  sr: any,
  workspaceId: string,
  containerIds: string[],
): Promise<number[]> {
  const count = containerIds.length;
  if (!count) return [];
  const top = await sr.entities.NumberReservation.filter({ workspace_id: workspaceId }, "-number", 1);
  const start = (top[0]?.number ?? 0) + 1;
  const mine: Array<{ id: string; number: number }> = [];
  for (let i = 0; i < count; i++) {
    const r = await sr.entities.NumberReservation.create({
      workspace_id: workspaceId, number: start + i, container_id: containerIds[i], reason: "import",
    });
    mine.push({ id: r.id, number: start + i });
  }
  await new Promise((resolve) => setTimeout(resolve, 450));

  const numbers: number[] = [];
  for (let i = 0; i < count; i++) {
    const dupes = await sr.entities.NumberReservation.filter({ workspace_id: workspaceId, number: mine[i].number });
    if (dupes.length > 1 && dupes.map((d: any) => d.id).sort()[0] !== mine[i].id) {
      await sr.entities.NumberReservation.delete(mine[i].id);
      numbers.push(await allocateNumber(sr, workspaceId, containerIds[i], "import"));
    } else {
      numbers.push(mine[i].number);
    }
  }
  return numbers;
}

/** Admin renumber: claims new_number if free; the old reservation stays retired. */
export async function reserveSpecificNumber(
  sr: any,
  workspaceId: string,
  containerId: string,
  number: number,
): Promise<void> {
  if (!Number.isInteger(number) || number < 1) throw new ApiError(400, "bad_request", "Invalid number");
  const existing = await sr.entities.NumberReservation.filter({ workspace_id: workspaceId, number });
  if (existing.length) throw new ApiError(409, "number_taken");
  const mine = await sr.entities.NumberReservation.create({
    workspace_id: workspaceId,
    number,
    container_id: containerId,
    reason: "renumber",
  });
  await sleep(300);
  const dupes = await sr.entities.NumberReservation.filter({ workspace_id: workspaceId, number });
  if (dupes.length > 1 && winnerOf(dupes) !== mine.id) {
    await sr.entities.NumberReservation.delete(mine.id);
    throw new ApiError(409, "number_taken");
  }
}

/** 001, 002 … expanding naturally past 999. */
export function formatNumber(n: number): string {
  return String(n).padStart(3, "0");
}
