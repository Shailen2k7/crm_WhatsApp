'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * THE AUTOMATION SWITCHES — top of Settings.
 *
 * One row per step of the chase, each with its own on/off switch and daily
 * limit, so the team can pause any part (or all of it) without code or a
 * deploy. The server checks that the person is an admin; everyone else sees
 * the same rows read-only.
 *
 * Turning a step off only pauses it: nobody is skipped or forgotten. When it
 * comes back on, people who became due in the meantime are picked up, oldest
 * first, within the daily limit — never in a burst.
 */

interface Rule {
  key: string;
  enabled: boolean;
  template_name: string | null;
  daily_cap: number | null;
  sentToday: number;
}

const STEPS: { key: string; title: string; when: string }[] = [
  { key: 'new_lead_first', title: 'T1 — first message', when: 'Within minutes of a new lead arriving' },
  { key: 'no_reply_t1r', title: 'T1 retry', when: 'If Meta refused T1 — after 4 days, then 10 days' },
  { key: 'no_reply_t2', title: 'T2 — follow-up', when: '1 day after T1, if no reply' },
  { key: 'no_reply_t3', title: 'T3 — follow-up', when: '3 days after T1, if no reply' },
  { key: 'no_reply_t4', title: 'T4 — last follow-up', when: '7 days after T1, if no reply' },
];

export function AutomationSwitches() {
  const [rules, setRules] = useState<Map<string, Rule> | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/automation/switch', { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not load the automations.'); return; }
      setIsAdmin(!!json.isAdmin);
      setRules(new Map((json.rules as Rule[]).map((r) => [r.key, r])));
    } catch {
      setError('Could not load the automations.');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);   // keeps "sent today" fresh while the page is open
    return () => clearInterval(t);
  }, [load]);

  async function change(key: string, patch: { enabled?: boolean; dailyCap?: number }) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch('/api/automation/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, ...patch }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not save.'); return; }
      setRules((prev) => {
        const next = new Map(prev || []);
        const old = next.get(key);
        next.set(key, { ...(old as Rule), ...json.rule, sentToday: old?.sentToday ?? 0 });
        return next;
      });
      setCapDraft((d) => { const n = { ...d }; delete n[key]; return n; });
    } catch {
      setError('Network error — nothing was changed.');
    } finally {
      setBusy(null);
    }
  }

  function toggle(r: Rule, s: (typeof STEPS)[number]) {
    const turningOn = !r.enabled;
    const msg = turningOn
      ? `Switch ON “${s.title}”?\n\nIt starts sending to customers on the next run (within 5 minutes)${r.key === 'new_lead_first' ? ', at any hour' : ', 10am–7pm IST'}, up to ${r.daily_cap || 'unlimited'} a day.`
      : `Switch OFF “${s.title}”?\n\nNothing is lost: anyone who becomes due while it is off is picked up when you switch it back on.`;
    if (!confirm(msg)) return;
    change(r.key, { enabled: turningOn });
  }

  function saveCap(key: string) {
    const raw = (capDraft[key] ?? '').trim();
    const cap = Number(raw);
    if (raw === '' || !Number.isInteger(cap) || cap < 0) { setError('Daily limit must be a whole number (0 = no limit).'); return; }
    change(key, { dailyCap: cap });
  }

  const allOn = rules ? STEPS.every((s) => rules.get(s.key)?.enabled) : false;
  const anyOn = rules ? STEPS.some((s) => rules.get(s.key)?.enabled) : false;

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, padding: '16px 18px', marginBottom: 16, boxShadow: 'var(--shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', flex: 1 }}>
          Automation
        </div>
        {rules && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: anyOn ? 'var(--teal-bg)' : 'var(--surface-3)', color: anyOn ? 'var(--teal-ink)' : 'var(--muted)' }}>
            {allOn ? 'All on' : anyOn ? 'Partly on' : 'All off'}
          </span>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 8px' }}>
        Follow-ups go out 10am–7pm IST. A person stops getting them the moment they reply, someone on the team messages them, or their stage is set to Hot, Won, Junk or Lost.
        {!isAdmin && rules && <><br /><strong>Only an admin can change these.</strong></>}
      </p>

      {error && (
        <div style={{ background: 'var(--red-bg)', color: 'var(--red)', padding: '8px 11px', borderRadius: 9, fontSize: 12.3, marginBottom: 8 }}>{error}</div>
      )}

      {!rules && !error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--muted)', padding: '8px 0' }}>
          <Loader2 size={13} style={{ animation: 'spin .8s linear infinite' }} /> Loading…
        </div>
      )}

      {rules && STEPS.map((s) => {
        const r = rules.get(s.key);
        if (!r) return null;
        const draft = capDraft[s.key];
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--line-2)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                {s.title}
                <code style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 500 }}>{r.template_name}</code>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                {s.when} · <strong style={{ color: 'var(--ink-2)' }}>{r.sentToday}</strong> sent today
              </div>
            </div>

            <label title="Daily limit (0 = no limit)" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)', flex: 'none' }}>
              max/day
              <input
                inputMode="numeric"
                disabled={!isAdmin || busy === s.key}
                value={draft ?? String(r.daily_cap ?? 0)}
                onChange={(e) => setCapDraft((d) => ({ ...d, [s.key]: e.target.value.replace(/[^\d]/g, '') }))}
                onBlur={() => { if (draft !== undefined && draft !== String(r.daily_cap ?? 0)) saveCap(s.key); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 48, padding: '4px 6px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 12.5, textAlign: 'center', outline: 'none' }}
              />
            </label>

            <button
              role="switch"
              aria-checked={r.enabled}
              aria-label={`${s.title} ${r.enabled ? 'on' : 'off'}`}
              disabled={!isAdmin || busy === s.key}
              onClick={() => toggle(r, s)}
              style={{
                position: 'relative', width: 40, height: 23, borderRadius: 99, border: 0, flex: 'none',
                background: r.enabled ? 'var(--teal)' : 'var(--surface-3)',
                cursor: isAdmin ? 'pointer' : 'not-allowed', opacity: busy === s.key ? 0.6 : 1,
                transition: 'background .15s',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: r.enabled ? 20 : 3, width: 17, height: 17, borderRadius: 99,
                background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s',
              }} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
