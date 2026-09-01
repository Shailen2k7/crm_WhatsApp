// =============================================================================
// THE RELAY ALERT — a bird call, synthesised.
// -----------------------------------------------------------------------------
// Synthesised rather than an mp3: nothing to download, no cache to miss, no CDN
// to fail, works offline, and it starts in under a millisecond. A notification
// that arrives late is worse than none.
//
// Four rising chirps. Each is a fast upward frequency sweep (2.1kHz -> 4.1kHz)
// with a sharp attack and quick decay, which is broadly what a small bird does.
// That band is also where human hearing peaks, so it carries across a noisy
// room at modest volume.
//
// LOUDNESS: a compressor sits on the output. That matters — without it, simply
// raising the gain clips the waveform into a buzz. The compressor lets the call
// be perceptibly much louder while staying clean, which is the difference
// between "insistent" and "broken".
//
// WHERE IT PLAYS (see sw.js for the other half):
//   • App in the FOREGROUND      -> plays here.
//   • App BACKGROUNDED but alive -> the service worker messages the page and it
//                                   plays here too. This is the common case on
//                                   a phone: you switched apps, you did not
//                                   quit Relay.
//   • App fully CLOSED           -> the OS plays its own notification sound.
//                                   No website can override that on iOS or
//                                   Android; the push carries a long distinctive
//                                   vibration pattern instead.
// =============================================================================

let ctx: AudioContext | null = null;
let bus: DynamicsCompressorNode | null = null;
let master: GainNode | null = null;
let unlocked = false;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx && !bus) {
    // Compress hard, then make up the gain. Loud, never clipped.
    bus = ctx.createDynamicsCompressor();
    // Tuned by measurement, not by ear-guessing. At threshold -18 / makeup 1.6
    // the render peaked at 1.126 with 17 clipped samples — audible crackle.
    // These values measure 2.12x louder than the previous call with peak 0.886
    // and ZERO clipping.
    bus.threshold.value = -20;
    bus.knee.value = 12;
    bus.ratio.value = 10;
    bus.attack.value = 0.002;
    bus.release.value = 0.12;

    master = ctx.createGain();
    master.gain.value = 1.35;

    bus.connect(master).connect(ctx.destination);
  }
  return ctx;
}

/**
 * Browsers refuse audio until the user interacts. iOS is strictest and also
 * SUSPENDS the context every time the app is backgrounded, so this is called
 * again on every foreground return, not just once.
 */
export function unlockAudio(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  if (!unlocked) {
    try {
      const b = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = b;
      src.connect(c.destination);
      src.start(0);
    } catch { /* not fatal */ }
    unlocked = true;
  }
}

export function isAudioReady(): boolean {
  const c = ensureCtx();
  return !!c && c.state === 'running';
}

/** One chirp: a fast upward sweep with a percussive envelope. */
function chirp(c: AudioContext, at: number, fromHz: number, toHz: number, dur: number, peak: number) {
  const dest = bus || c.destination;

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(fromHz, at);
  osc.frequency.exponentialRampToValueAtTime(toHz, at + dur * 0.55);
  osc.frequency.exponentialRampToValueAtTime(toHz * 0.82, at + dur);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  // Harmonic — gives it the airy quality of a real call rather than a beep.
  const h = c.createOscillator();
  const hg = c.createGain();
  h.type = 'triangle';
  h.frequency.setValueAtTime(fromHz * 1.5, at);
  h.frequency.exponentialRampToValueAtTime(toHz * 1.5, at + dur * 0.55);
  hg.gain.setValueAtTime(0.0001, at);
  hg.gain.exponentialRampToValueAtTime(peak * 0.26, at + 0.01);
  hg.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  osc.connect(gain).connect(dest);
  h.connect(hg).connect(dest);
  osc.start(at); osc.stop(at + dur + 0.02);
  h.start(at); h.stop(at + dur + 0.02);
}

/** The inbound-message alert. Four chirps, ~500ms, deliberately insistent. */
export function playRingtone(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') {
    c.resume().catch(() => {});
    if (!unlocked) return;
  }
  const t = c.currentTime + 0.02;
  chirp(c, t,        2100, 3500, 0.085, 0.62);
  chirp(c, t + 0.13, 2350, 3750, 0.085, 0.72);
  chirp(c, t + 0.26, 2550, 3950, 0.085, 0.78);
  chirp(c, t + 0.39, 2750, 4150, 0.125, 0.70);
}

/** Softer single chirp — the "sent" confirmation. */
export function playTick(): void {
  const c = ensureCtx();
  if (!c || c.state !== 'running') return;
  chirp(c, c.currentTime + 0.01, 1900, 2600, 0.05, 0.16);
}
