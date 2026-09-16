// =============================================================================
// SIGNALS — one tiny, dependency-free timeout helper.
// -----------------------------------------------------------------------------
// Kept in its own file so the shared WhatsApp send layer can use it without
// importing anything else from the automation.
// =============================================================================

/**
 * A signal that aborts when ANY source aborts, or after `timeoutMs`.
 * Call `done()` when the operation finishes so no timer or listener lingers.
 * Hand-written rather than AbortSignal.any/timeout so it behaves the same on
 * whichever Node version the platform runs.
 */
export function linkedSignal(
  sources: (AbortSignal | null | undefined)[],
  timeoutMs: number,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`call exceeded ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  );
  const unhook: (() => void)[] = [];
  for (const s of sources) {
    if (!s) continue;
    if (s.aborted) { controller.abort(s.reason); break; }
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    unhook.push(() => s.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    done: () => { clearTimeout(timer); unhook.forEach((u) => u()); },
  };
}
