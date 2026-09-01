'use client';

// =============================================================================
// NOTIFICATION DIAGNOSTICS — because "it didn't buzz" is not debuggable.
// -----------------------------------------------------------------------------
// Every link in the chain is shown separately, with a test for each, so a
// failure names itself instead of being a shrug. The chain is:
//
//   permission -> service worker -> push subscription -> device delivery
//
// Any one of those can be the reason nothing arrived, and they fail silently
// by design in every browser.
// =============================================================================
import { useCallback, useEffect, useState } from 'react';
import { BellRing, Volume2, Smartphone, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { enablePush } from '@/lib/push-client';
import { playRingtone, unlockAudio, isAudioReady } from '@/lib/chime';

type Perm = 'default' | 'granted' | 'denied' | 'unsupported';

export function NotificationPanel() {
  const [perm, setPerm] = useState<Perm>('default');
  const [swReady, setSwReady] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [audioOk, setAudioOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isIosNotInstalled, setIosNotInstalled] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) { setPerm('unsupported'); return; }
    setPerm(Notification.permission as Perm);
    setAudioOk(isAudioReady());

    // iOS refuses push entirely until the PWA is added to the Home Screen —
    // the single most common reason notifications "don't work on iPhone".
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIosNotInstalled(iOS && !standalone);

    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      setSwReady(!!reg);
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(!!sub);
      } else setSubscribed(false);
    } else {
      setSwReady(false);
      setSubscribed(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function turnOn() {
    setBusy(true); setResult(null);
    unlockAudio();
    const r = await enablePush();
    await refresh();
    setBusy(false);
    setResult(
      r === 'subscribed' ? 'This device is registered for notifications.'
      : r === 'denied' ? 'You blocked notifications. Enable them for this site in your browser settings, then try again.'
      : r === 'unsupported' ? 'This browser does not support web push.'
      : r === 'no-key' ? 'Push is not configured on this deployment (VAPID keys missing).'
      : 'Could not register this device.'
    );
  }

  async function testPush() {
    setBusy(true); setResult(null);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const j = await res.json();
      setResult(j.ok ? `${j.note} (${j.registeredDevices} device(s) registered)` : j.error || 'Test failed.');
    } catch {
      setResult('Could not reach the server.');
    }
    setBusy(false);
  }

  const rows: { label: string; ok: boolean | null; detail: string }[] = [
    { label: 'Permission granted', ok: perm === 'granted', detail: perm },
    { label: 'Service worker installed', ok: swReady, detail: swReady ? 'active' : 'not registered' },
    { label: 'This device registered', ok: subscribed, detail: subscribed ? 'subscribed' : 'not subscribed' },
    { label: 'Sound unlocked', ok: audioOk, detail: audioOk ? 'ready' : 'tap anywhere first' },
  ];

  return (
    <section style={card}>
      <div style={cardTitle}>Notifications</div>

      {isIosNotInstalled && (
        <div style={warn}>
          <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1, color: 'var(--amber)' }} />
          <div>
            <strong>On iPhone, add Migrizo to your Home Screen first.</strong>
            <br />
            Safari → Share → <em>Add to Home Screen</em>, then open Migrizo from that icon. Apple does not
            allow web notifications until you do — this is an iOS rule, not a setting here.
          </div>
        </div>
      )}

      {rows.map((r) => (
        <div key={r.label} style={row}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-2)' }}>
            {r.ok === null ? (
              <Loader2 size={14} style={{ animation: 'spin .8s linear infinite', color: 'var(--muted)' }} />
            ) : r.ok ? (
              <Check size={14} style={{ color: 'var(--teal)' }} />
            ) : (
              <X size={14} style={{ color: 'var(--red)' }} />
            )}
            {r.label}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.detail}</span>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
        <button onClick={turnOn} disabled={busy} style={primary}>
          {busy ? <Loader2 size={13} style={{ animation: 'spin .8s linear infinite' }} /> : <BellRing size={14} />}
          {perm === 'granted' && subscribed ? 'Re-register device' : 'Turn on notifications'}
        </button>
        <button onClick={() => { unlockAudio(); playRingtone(); setAudioOk(true); }} style={ghost}>
          <Volume2 size={14} /> Play the sound
        </button>
        <button onClick={testPush} disabled={busy} style={ghost}>
          <Smartphone size={14} /> Send a test notification
        </button>
      </div>

      {result && (
        <div style={{ fontSize: 12.3, color: 'var(--ink-2)', lineHeight: 1.55, paddingTop: 10 }}>{result}</div>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6, paddingTop: 12, borderTop: '1px solid var(--line-2)', marginTop: 12 }}>
        <strong style={{ color: 'var(--ink-2)' }}>What you will hear.</strong> With Migrizo open, a new message plays
        its bird call. With it closed, your phone plays its own notification sound — no website can replace
        the system sound on iOS or Android — so the alert is identified by its long double-buzz vibration instead.
      </div>
    </section>
  );
}

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13,
  padding: '16px 18px', marginBottom: 16, boxShadow: 'var(--shadow)',
};
const cardTitle: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
  color: 'var(--muted)', marginBottom: 9,
};
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
  padding: '7px 0', borderTop: '1px solid var(--line-2)',
};
const warn: React.CSSProperties = {
  display: 'flex', gap: 9, background: 'var(--amber-bg)', color: 'var(--ink)',
  padding: '11px 13px', borderRadius: 10, fontSize: 12.3, lineHeight: 1.55, marginBottom: 10,
};
const primary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 15px', borderRadius: 9,
  border: 0, background: 'var(--teal)', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
};
const ghost: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 15px', borderRadius: 9,
  border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink-2)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
