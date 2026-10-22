// Small helpers for batched Supabase reads.
//
// `.in()` filters are kept to 100 values per query (URL length), so big reads
// come in chunks — and chunks must run SIDE BY SIDE, a few at a time. Run one
// after another, ~25 round trips cost 7–9 s: that starved every chase send on
// 22 Oct 2026 and made the Automation screen take 5–8 s per click.

export const chunk = <T,>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Maps `fn` over `items`, at most `width` at a time, keeping order. */
export async function inParallel<T, R>(items: T[], fn: (item: T) => Promise<R>, width = 6): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
