// Normalized search_text maintenance for containers and items. Kept lowercase
// and diacritic-free so keyword search can token-match cheaply.

export function buildSearchText(parts: Array<string | string[] | null | undefined>): string {
  const flat: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p)) flat.push(...p);
    else flat.push(p);
  }
  return flat
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}
