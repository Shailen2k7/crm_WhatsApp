// =============================================================================
// THE RELAY RINGTONE — a distinctive in-app sound for inbound messages.
// -----------------------------------------------------------------------------
// Synthesised with WebAudio, so there is no asset to load and it works offline.
// A rising four-note motif played twice: unmistakable across a room, short
// enough not to be irritating on a busy day.
//
// HONEST LIMIT: this plays while Relay is OPEN (tab or installed app, even in
// the background on desktop). When the app is fully closed, the OS notification
// sound plays instead — the web cannot replace the system sound. The push
// notification carries a long distinctive VIBRATION pattern for that case.
//
// Browsers block audio until the user has interacted with the page once, so
// unlock() is wired to the first click/keypress.
// =============================================================================

let ctx: AudioContext | null = null;
let unlocked = false;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Call once on first user interaction — resumes the suspended context. */
export function unlockAudio(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  unlocked = true;
}

function tone(c: AudioContext, freq: number, start: number, dur: number, gainPeak: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // A touch of a second harmonic makes it ring like a bell, not beep like an alarm.
  const osc2 = c.createOscillator();
  osc2.type = 'triangle';
  osc2.frequency.value = freq * 2;
  const g2 = c.createGain();
  g2.gain.value = 0.18;

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  osc.connect(gain); osc2.connect(g2); g2.connect(gain);
  gain.connect(c.destination);
  osc.start(start); osc.stop(start + dur + 0.05);
  osc2.start(start); osc2.stop(start + dur + 0.05);
}

/** The inbound-message ringtone. Loud by design — the business runs on this. */
export function playRingtone(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') { c.resume().catch(() => {}); if (!unlocked) return; }
  const t = c.currentTime + 0.02;
  // C5 E5 G5 C6 — twice, second time brighter.
  const motif = [523.25, 659.25, 783.99, 1046.5];
  motif.forEach((f, i) => tone(c, f, t + i * 0.09, 0.22, 0.5));
  motif.forEach((f, i) => tone(c, f, t + 0.5 + i * 0.09, 0.26, 0.62));
}

/** Softer tick for outbound/delivery events. */
export function playTick(): void {
  const c = ensureCtx();
  if (!c || c.state === 'suspended') return;
  tone(c, 880, c.currentTime + 0.01, 0.08, 0.15);
}
