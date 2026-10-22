'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, RotateCw, MessageSquare, FileText, Snowflake, Flame } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

/**
 * SETTINGS → AUTOMATION. One tab per AUTOMATION ENGINE — the CV & LinkedIn
 * chase today; the Cold and Hot lead chases next (shown as design previews,
 * with no engine and no live switches, until they are built). Inside each tab
 * the engine's steps sit on a timeline; pick a step to manage it.
 *
 * Step management (unchanged):
 *
 * Each tab is the whole story of that step: its switch and daily limit, the
 * exact approved wording, how it has done this week, who it went to (with the
 * real WhatsApp outcome), who is next and when, and who is out for good and
 * why. The T1 tab also lists leads whose first message never arrived, with a
 * Resend button for the ones a resend can actually help.
 *
 * Everything shown comes from the same loader and planner the sending engine
 * uses (see /api/automation/overview), so the screen cannot promise anything
 * the engine will not do. Only admins can change anything; the server checks.
 */

type Key = 'new_lead_first' | 'no_reply_t1r' | 'no_reply_t2' | 'no_reply_t3' | 'no_reply_t4';

const TABS: { key: Key; label: string; title: string; when: string }[] = [
  { key: 'new_lead_first', label: 'T1', title: 'T1 — first message', when: 'Goes to every new lead within minutes, at any hour.' },
  { key: 'no_reply_t1r', label: 'T1 retry', title: 'T1 retry', when: 'If Meta refused T1 (“healthy ecosystem”): sent again after 4 days, then after 10 days, then never.' },
  { key: 'no_reply_t2', label: 'T2', title: 'T2 — follow-up', when: '1 day after T1 arrived, if they have not replied. 10am–7pm IST.' },
  { key: 'no_reply_t3', label: 'T3', title: 'T3 — follow-up', when: '3 days after T1, if still no reply. 10am–7pm IST.' },
  { key: 'no_reply_t4', label: 'T4', title: 'T4 — last follow-up', when: '7 days after T1, if still no reply. The final message. 10am–7pm IST.' },
];

const STEP_DAY: Record<Key, string> = {
  new_lead_first: 'Day 0',
  no_reply_t1r: 'If Meta refused',
  no_reply_t2: 'Day 1',
  no_reply_t3: 'Day 3',
  no_reply_t4: 'Day 7',
};

interface Overview {
  isAdmin: boolean;
  rule: { key: string; enabled: boolean; template_name: string | null; daily_cap: number | null; body: string | null };
  stats: { today: number; week: number; delivered: number; read: number; refused: number; replied: number };
  sent: { leadId: string | null; phone: string; name: string | null; sentAt: string; status: string; error: string | null; replied: boolean }[];
  next: { leadId: string | null; phone: string; name: string | null; at: string; state: 'due' | 'scheduled' | 'meta_pause' | 'switch_off' }[];
  stopped: { leadId: string | null; phone: string; name: string | null; at: string; reason: string }[];
  undelivered: { leadId: string | null; phoneE164: string; name: string | null; t1At: string; reason: string; canResend: boolean; note: string | null }[];
}

const fmt = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

// ---- SESSION CACHE -----------------------------------------------------------
// Kept at module level, so it survives switching steps, switching engines and
// leaving Settings: a step you have opened once shows INSTANTLY next time, and
// is refreshed quietly behind it. Only this browser tab's memory — nothing is
// stored, and a page reload starts clean.
const overviewCache = new Map<Key, Overview>();
let switchCache: Partial<Record<Key, boolean>> | null = null;
let selectedStep: Key = 'new_lead_first';
/** A refresh already running for a step — clicks never start a second one. */
const inFlight = new Map<Key, Promise<Overview | null>>();

/** `force` = after a change (switch, limit, resend): never reuse a read that began before it. */
function fetchOverview(k: Key, force = false): Promise<Overview | null> {
  const running = inFlight.get(k);
  if (running && !force) return running;
  const p = fetch(`/api/automation/overview?key=${k}`, { cache: 'no-store' })
    .then((r) => r.json())
    .then((json) => {
      if (!json.ok) throw new Error(json.error || 'Could not load.');
      overviewCache.set(k, json as Overview);
      return json as Overview;
    })
    .finally(() => { if (inFlight.get(k) === p) inFlight.delete(k); });
  inFlight.set(k, p);
  return p;
}

function CvChase({ onOpenChat }: { onOpenChat?: (key: string) => void }) {
  const [tab, setTabState] = useState<Key>(selectedStep);
  const setTab = (k: Key) => { selectedStep = k; setTabState(k); };
  const [data, setData] = useState<Partial<Record<Key, Overview>>>(() => Object.fromEntries(overviewCache));
  const [onMap, setOnMap] = useState<Partial<Record<Key, boolean>>>(() => switchCache || {});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fetch one step; with `quiet`, a failure keeps what is on screen. */
  const load = useCallback(async (k: Key, quiet = false, force = false) => {
    if (!quiet) { setLoading(true); setError(null); }
    try {
      const ov = await fetchOverview(k, force);
      if (!ov) return;
      setData((d) => ({ ...d, [k]: ov }));
      setOnMap((m) => { const n = { ...m, [k]: !!ov.rule?.enabled }; switchCache = n; return n; });
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : 'Could not load — check your connection.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  // The step dots: one light call for all five switches.
  const loadSwitches = useCallback(async () => {
    try {
      const res = await fetch('/api/automation/switch', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) {
        const m = Object.fromEntries((json.rules as { key: Key; enabled: boolean }[]).map((r) => [r.key, r.enabled]));
        switchCache = m;
        setOnMap(m);
      }
    } catch { /* dots are decoration */ }
  }, []);

  useEffect(() => { loadSwitches(); }, [loadSwitches]);

  // Show what we have at once; refresh behind it. A step never seen before
  // shows the loader only until its first answer.
  useEffect(() => {
    load(tab, overviewCache.has(tab));
    const t = setInterval(() => load(tab, true), 60_000);
    return () => clearInterval(t);
  }, [tab, load]);

  // Pick up steps the warm-up (below) finishes while this view is open.
  useEffect(() => {
    const t = setInterval(() => {
      setData((d) => {
        let changed = false;
        const n = { ...d };
        for (const [k, v] of overviewCache) if (!n[k]) { n[k] = v; changed = true; }
        return changed ? n : d;
      });
    }, 400);
    return () => clearInterval(t);
  }, []);

  const meta = TABS.find((t) => t.key === tab)!;
  const ov = data[tab];

  return (
    <div>
      {/* ---- the steps, in the order a lead meets them ---- */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 14, paddingBottom: 2 }}>
        {TABS.map((t, i) => {
          const active = t.key === tab;
          const on = onMap[t.key];
          return (
            <div key={t.key} style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
              {i > 0 && <ChevronRight size={14} style={{ color: 'var(--muted)', margin: '0 2px', flex: 'none' }} />}
              <button
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                style={{
                  textAlign: 'left', padding: '8px 12px', borderRadius: 11, cursor: 'pointer', minWidth: 86,
                  border: '1px solid ' + (active ? 'var(--teal)' : 'var(--line)'),
                  background: active ? 'var(--teal-bg)' : 'var(--surface)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: active ? 'var(--teal-ink)' : 'var(--ink)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, flex: 'none', background: on === undefined ? 'var(--line)' : on ? 'var(--teal)' : 'var(--muted)', opacity: on ? 1 : 0.5 }} />
                  {t.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{STEP_DAY[t.key]}</div>
              </button>
            </div>
          );
        })}
      </div>

      {error && <div style={{ background: 'var(--red-bg)', color: 'var(--red)', padding: '9px 12px', borderRadius: 10, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

      {!ov ? (
        <Card><div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13, padding: '6px 0' }}><Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} /> Loading {meta.label}…</div></Card>
      ) : (
        <TabBody
          key={tab}
          k={tab}
          meta={meta}
          ov={ov}
          loading={loading}
          onReload={() => { load(tab, false, true); loadSwitches(); }}
          onOpenChat={onOpenChat}
        />
      )}
    </div>
  );
}

function TabBody({
  k, meta, ov, loading, onReload, onOpenChat,
}: {
  k: Key; meta: (typeof TABS)[number]; ov: Overview; loading: boolean;
  onReload: () => void; onOpenChat?: (key: string) => void;
}) {
  const isT1 = k === 'new_lead_first';
  const lists = useMemo(() => (isT1
    ? [
      { id: 'undelivered', label: 'Never arrived', count: ov.undelivered.length },
      { id: 'sent', label: 'Sent', count: ov.sent.length },
      { id: 'stopped', label: 'Skipped', count: ov.stopped.length },
    ]
    : [
      { id: 'next', label: 'Next up', count: ov.next.length },
      { id: 'sent', label: 'Sent', count: ov.sent.length },
      { id: 'stopped', label: 'Stopped', count: ov.stopped.length },
    ]), [isT1, ov]);
  const [list, setList] = useState(lists[0].id);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [showBody, setShowBody] = useState(false);

  async function saveSwitch(patch: { enabled?: boolean; dailyCap?: number }) {
    setBusy('switch'); setMsg(null);
    try {
      const res = await fetch('/api/automation/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, ...patch }) });
      const json = await res.json();
      if (!json.ok) setMsg({ ok: false, text: json.error || 'Could not save.' });
      else { setCapDraft(null); onReload(); }
    } catch { setMsg({ ok: false, text: 'Network error — nothing was changed.' }); }
    finally { setBusy(null); }
  }

  function toggle() {
    const on = !ov.rule.enabled;
    const text = on
      ? `Switch ON “${meta.title}”?\n\nIt starts sending to customers on the next run (within 5 minutes)${isT1 ? ', at any hour' : ', 10am–7pm IST'}, up to ${ov.rule.daily_cap || 'unlimited'} a day.`
      : `Switch OFF “${meta.title}”?\n\nNothing is lost: anyone who becomes due while it is off is picked up when you switch it back on.`;
    if (confirm(text)) saveSwitch({ enabled: on });
  }

  function saveCap() {
    if (capDraft === null) return;
    const n = Number(capDraft);
    if (capDraft.trim() === '' || !Number.isInteger(n) || n < 0) { setMsg({ ok: false, text: 'Daily limit must be a whole number (0 = no limit).' }); return; }
    if (n !== (ov.rule.daily_cap ?? 0)) saveSwitch({ dailyCap: n });
    else setCapDraft(null);
  }

  async function resend(phone: string, name: string | null, ask = true): Promise<boolean> {
    if (ask && !confirm(`Resend T1 to ${name || phone}?\n\nIt is checked again just before sending — if they have replied or been contacted since, it will not go.`)) return false;
    setBusy(phone); setMsg(null);
    try {
      const res = await fetch('/api/automation/resend-t1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
      const json = await res.json();
      if (!json.ok) { setMsg({ ok: false, text: `${name || phone}: ${json.error}` }); return false; }
      setMsg({ ok: true, text: `T1 resent to ${name || phone}. The chat will show whether WhatsApp delivered it.` });
      return true;
    } catch { setMsg({ ok: false, text: 'Network error — check the chat before trying again.' }); return false; }
    finally { setBusy(null); }
  }

  async function resendAll() {
    const ready = ov.undelivered.filter((u) => u.canResend);
    if (!ready.length) return;
    if (!confirm(`Resend T1 to all ${ready.length} who can be retried?\n\nEach is checked again just before sending.`)) return;
    let ok = 0;
    for (const u of ready) if (await resend(u.phoneE164, u.name, false)) ok++;
    setMsg({ ok: ok > 0, text: `Resent to ${ok} of ${ready.length}. Delivery shows in each chat within a few minutes.` });
    onReload();
  }

  const r = ov.rule;
  const s = ov.stats;
  const pct = (n: number) => (s.week ? `${Math.round((100 * n) / s.week)}%` : '—');
  const readyCount = ov.undelivered.filter((u) => u.canResend).length;

  return (
    <>
      {/* ---- control ---- */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{meta.title}</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: r.enabled ? 'var(--teal-bg)' : 'var(--surface-3)', color: r.enabled ? 'var(--teal-ink)' : 'var(--muted)' }}>
                {r.enabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{meta.when}</div>
          </div>
          <Switch on={r.enabled} disabled={!ov.isAdmin || busy === 'switch'} onClick={toggle} label={meta.title} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line-2)', fontSize: 12.5, color: 'var(--muted)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Max per day
            <input
              inputMode="numeric"
              disabled={!ov.isAdmin || busy === 'switch'}
              value={capDraft ?? String(r.daily_cap ?? 0)}
              onChange={(e) => setCapDraft(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={saveCap}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ width: 54, padding: '4px 6px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 12.5, textAlign: 'center', outline: 'none' }}
            />
            <span style={{ fontSize: 11 }}>(0 = no limit)</span>
          </label>
          <span>Template <code style={{ color: 'var(--ink-2)' }}>{r.template_name}</code></span>
          <button onClick={() => setShowBody((v) => !v)} style={linkBtn}>
            {showBody ? 'Hide message' : 'See message'} <ChevronDown size={12} style={{ transform: showBody ? 'rotate(180deg)' : 'none' }} />
          </button>
          <button onClick={onReload} disabled={loading} style={{ ...linkBtn, marginLeft: 'auto' }}>
            <RefreshCw size={12} style={{ animation: loading ? 'spin .8s linear infinite' : undefined }} /> Refresh
          </button>
        </div>
        {showBody && (
          <div style={{ marginTop: 10, padding: '11px 13px', borderRadius: 10, background: 'var(--surface-2)', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {(r.body || 'Wording not registered.').replace(/\{\{\s*1\s*\}\}/g, 'Name')}
          </div>
        )}
        {!ov.isAdmin && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Only an admin can change these.</div>}
      </Card>

      {/* ---- numbers ---- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8, marginBottom: 14 }}>
        <Tile label="Sent today" value={s.today} />
        <Tile label="Last 7 days" value={s.week} />
        <Tile label="Delivered" value={s.delivered} sub={pct(s.delivered)} />
        <Tile label="Refused by Meta" value={s.refused} sub={pct(s.refused)} warn={s.refused > 0} />
        <Tile label="Replied" value={s.replied} sub={pct(s.replied)} good={s.replied > 0} />
      </div>

      {msg && (
        <div style={{ background: msg.ok ? 'var(--teal-bg)' : 'var(--red-bg)', color: msg.ok ? 'var(--teal-ink)' : 'var(--red)', padding: '9px 12px', borderRadius: 10, fontSize: 12.5, marginBottom: 12 }}>{msg.text}</div>
      )}

      {/* ---- lists ---- */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {lists.map((l) => (
            <button
              key={l.id}
              onClick={() => setList(l.id)}
              style={{
                padding: '5px 11px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: '1px solid ' + (list === l.id ? 'transparent' : 'var(--line)'),
                background: list === l.id ? 'var(--ink)' : 'transparent', color: list === l.id ? 'var(--surface)' : 'var(--ink-2)',
              }}
            >
              {l.label} <span style={{ opacity: 0.7 }}>{l.count}</span>
            </button>
          ))}
          {isT1 && list === 'undelivered' && ov.isAdmin && readyCount > 1 && (
            <button onClick={resendAll} disabled={!!busy} style={{ ...primaryBtn, marginLeft: 'auto' }}>
              <RotateCw size={12} /> Resend all {readyCount}
            </button>
          )}
        </div>

        <ListHint id={list} isT1={isT1} />

        <div style={{ maxHeight: 460, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {list === 'undelivered' && (ov.undelivered.length === 0
            ? <Empty text="Every T1 reached its lead, or someone has taken them over." />
            : ov.undelivered.map((u) => (
              <Line key={u.phoneE164} name={u.name} phone={u.phoneE164} onOpen={u.leadId && onOpenChat ? () => onOpenChat(u.leadId!) : undefined}
                sub={<>{u.reason} · T1 {fmt(u.t1At)}{u.note ? <><br /><span style={{ color: u.canResend ? 'var(--muted)' : 'var(--amber)' }}>{u.note}</span></> : null}</>}
                right={u.canResend && ov.isAdmin
                  ? <button onClick={() => resend(u.phoneE164, u.name).then((ok) => ok && onReload())} disabled={!!busy} style={primaryBtn}>
                    {busy === u.phoneE164 ? <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> : <RotateCw size={12} />} Resend
                  </button>
                  : <Chip tone={u.canResend ? 'teal' : 'grey'}>{u.canResend ? 'Can resend' : 'No resend'}</Chip>}
              />
            )))}

          {list === 'next' && (ov.next.length === 0
            ? <Empty text="Nobody is waiting for this step right now." />
            : ov.next.map((n) => (
              <Line key={n.phone} name={n.name} phone={n.phone} onOpen={n.leadId && onOpenChat ? () => onOpenChat(n.leadId!) : undefined}
                sub={n.state === 'switch_off' ? 'Due — waiting for this switch to be turned on'
                  : n.state === 'meta_pause' ? `Meta pause — earliest ${fmt(n.at)}`
                  : n.state === 'due' ? 'Due now — goes out on the next run (within the daily limit)'
                  : `Scheduled ${fmt(n.at)}`}
                right={<Chip tone={n.state === 'due' ? 'teal' : n.state === 'meta_pause' ? 'amber' : 'grey'}>
                  {n.state === 'due' ? 'Next run' : n.state === 'switch_off' ? 'Switch off' : n.state === 'meta_pause' ? 'Paused' : fmt(n.at)}
                </Chip>}
              />
            )))}

          {list === 'sent' && (ov.sent.length === 0
            ? <Empty text="Nothing sent in the last 30 days." />
            : ov.sent.map((x) => (
              <Line key={x.phone + x.sentAt} name={x.name} phone={x.phone} onOpen={x.leadId && onOpenChat ? () => onOpenChat(x.leadId!) : undefined}
                sub={<>{fmt(x.sentAt)}{x.replied ? <> · <span style={{ color: 'var(--teal-ink)', fontWeight: 600 }}>replied</span></> : null}{x.error ? <><br /><span style={{ color: 'var(--red)' }}>{x.error.slice(0, 90)}</span></> : null}</>}
                right={<StatusChip status={x.status} />}
              />
            )))}

          {list === 'stopped' && (ov.stopped.length === 0
            ? <Empty text={isT1 ? 'Nobody was skipped.' : 'Nobody has been stopped at this step.'} />
            : ov.stopped.map((x) => (
              <Line key={x.phone + x.at} name={x.name} phone={x.phone} onOpen={x.leadId && onOpenChat ? () => onOpenChat(x.leadId!) : undefined}
                sub={<>{x.reason} · {fmt(x.at)}</>}
                right={<Chip tone="grey">{isT1 ? 'Skipped' : 'Stopped'}</Chip>}
              />
            )))}
        </div>
      </Card>
    </>
  );
}

function ListHint({ id, isT1 }: { id: string; isT1: boolean }) {
  const text = id === 'undelivered'
    ? 'Leads whose T1 never reached them and whom nobody has contacted since. A resend is offered only where it can help.'
    : id === 'next' ? 'Who this step goes to next, and when. Anyone who replies, is messaged by the team, or is marked Hot/Won/Junk/Lost drops off automatically.'
    : id === 'sent' ? 'The last 30 days, with the real WhatsApp outcome.'
    : isT1 ? 'Leads who got no T1 because the team had already messaged them.'
    : 'People who will never get this step, and why.';
  return <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, margin: '2px 0 6px' }}>{text}</div>;
}

// ---------------------------------------------------------------- small parts
const linkBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 0, padding: 0, color: 'var(--teal-ink)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 8, border: 0, background: 'var(--teal)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 'none' };

function Card({ children }: { children: React.ReactNode }) {
  return <section style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, padding: '14px 16px', marginBottom: 14, boxShadow: 'var(--shadow)' }}>{children}</section>;
}

function Switch({ on, disabled, onClick, label }: { on: boolean; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={`${label} ${on ? 'on' : 'off'}`} disabled={disabled} onClick={onClick}
      style={{ position: 'relative', width: 46, height: 26, borderRadius: 99, border: 0, flex: 'none', background: on ? 'var(--teal)' : 'var(--surface-3)', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background .15s', opacity: disabled ? 0.7 : 1 }}>
      <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: 99, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s' }} />
    </button>
  );
}

function Tile({ label, value, sub, warn, good }: { label: string; value: number; sub?: string; warn?: boolean; good?: boolean }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 11, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 3 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: warn ? 'var(--amber)' : good ? 'var(--teal-ink)' : 'var(--ink)' }}>{value.toLocaleString('en-IN')}</span>
        {sub && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</span>}
      </div>
    </div>
  );
}

function Line({ name, phone, sub, right, onOpen }: { name: string | null; phone: string; sub: React.ReactNode; right: React.ReactNode; onOpen?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--line-2)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || phone}</span>
          {name && <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, flex: 'none' }}>{phone}</span>}
          {onOpen && (
            <button onClick={onOpen} title="Open chat" aria-label="Open chat" style={{ background: 'transparent', border: 0, padding: 2, color: 'var(--muted)', cursor: 'pointer', display: 'flex', flex: 'none' }}>
              <MessageSquare size={13} />
            </button>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{sub}</div>
      </div>
      <div style={{ flex: 'none' }}>{right}</div>
    </div>
  );
}

function Chip({ tone, children }: { tone: 'teal' | 'amber' | 'grey' | 'red' | 'blue'; children: React.ReactNode }) {
  const c = {
    teal: ['var(--teal-bg)', 'var(--teal-ink)'], amber: ['var(--amber-bg)', 'var(--amber)'], grey: ['var(--surface-3)', 'var(--muted)'],
    red: ['var(--red-bg)', 'var(--red)'], blue: ['rgba(52,183,241,.14)', '#1b8fc4'],
  }[tone];
  return <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: c[0], color: c[1], whiteSpace: 'nowrap' }}>{children}</span>;
}

function StatusChip({ status }: { status: string }) {
  if (status === 'read') return <Chip tone="blue">Read</Chip>;
  if (status === 'delivered') return <Chip tone="teal">Delivered</Chip>;
  if (status === 'failed') return <Chip tone="red">Not delivered</Chip>;
  if (status === 'queued') return <Chip tone="grey">Sending</Chip>;
  return <Chip tone="grey">Sent</Chip>;
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: '18px 4px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>{text}</div>;
}

// =============================================================================
// THE ENGINE TABS
// =============================================================================
type Engine = 'cv' | 'cold' | 'hot';

const ENGINES: { id: Engine; label: string; icon: React.ReactNode; live: boolean; blurb: string }[] = [
  { id: 'cv', label: 'CV & LinkedIn chase', icon: <FileText size={14} />, live: true, blurb: 'New leads: ask for the CV and LinkedIn, then follow up until they reply.' },
  { id: 'cold', label: 'Cold lead chase', icon: <Snowflake size={14} />, live: false, blurb: 'Leads marked Cold in the CRM: slow, spaced nudges over months.' },
  { id: 'hot', label: 'Hot & Spotlight', icon: <Flame size={14} />, live: true, blurb: 'Hot and Spotlight leads who have gone quiet: one value message (HS1→HS8) every 4 days until they reply.' },
];

let selectedEngine: Engine = 'cv';

export function AutomationCenter({ onOpenChat }: { onOpenChat?: (key: string) => void }) {
  const [engine, setEngineState] = useState<Engine>(selectedEngine);
  const setEngine = (e: Engine) => { selectedEngine = e; setEngineState(e); };
  const [cvOn, setCvOn] = useState<number | null>(() => (switchCache ? Object.values(switchCache).filter(Boolean).length : null));
  const [nurtureOn, setNurtureOn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/automation/switch', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      if (j.ok) setCvOn((j.rules as { enabled: boolean }[]).filter((x) => x.enabled).length);
    }).catch(() => {});
    fetch('/api/automation/nurture', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      if (j.ok) setNurtureOn(!!j.rule?.enabled);
    }).catch(() => {});
  }, [engine]);

  // WARM-UP: the moment the Automation section opens, fetch every step in the
  // background (two at a time, the selected one first), so the first click on
  // any of them is instant — not just the second.
  useEffect(() => {
    let cancelled = false;
    const order = [selectedStep, ...TABS.map((t) => t.key).filter((k) => k !== selectedStep)]
      .filter((k) => !overviewCache.has(k));
    let i = 0;
    const worker = async () => {
      while (!cancelled && i < order.length) {
        const k = order[i++];
        try { await fetchOverview(k); } catch { /* a click will retry */ }
      }
    };
    worker(); worker();
    return () => { cancelled = true; };
  }, []);

  const current = ENGINES.find((e) => e.id === engine)!;

  return (
    <div>
      <div role="tablist" style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 6, paddingBottom: 2 }}>
        {ENGINES.map((e) => {
          const active = e.id === engine;
          const status = !e.live ? 'Coming next'
            : e.id === 'cv' ? (cvOn === null ? '' : cvOn > 0 ? 'On' : 'Off')
            : e.id === 'hot' ? (nurtureOn === null ? '' : nurtureOn ? 'On' : 'Off')
            : '';
          return (
            <button
              key={e.id}
              role="tab"
              aria-selected={active}
              onClick={() => setEngine(e.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, flex: 'none',
                padding: '10px 14px', borderRadius: 12, cursor: 'pointer',
                border: '1px solid ' + (active ? 'transparent' : 'var(--line)'),
                background: active ? 'var(--ink)' : 'var(--surface)',
                color: active ? 'var(--surface)' : 'var(--ink-2)', fontSize: 13.5, fontWeight: 700,
              }}
            >
              {e.icon}
              {e.label}
              {status && (
                <span style={{
                  fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
                  background: status === 'On' ? 'var(--teal)' : active ? 'rgba(255,255,255,.16)' : 'var(--surface-3)',
                  color: status === 'On' ? '#fff' : active ? 'var(--surface)' : 'var(--muted)',
                }}>{status}</span>
              )}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 16px', lineHeight: 1.5 }}>{current.blurb}</p>

      {engine === 'cv' && <CvChase onOpenChat={onOpenChat} />}
      {engine === 'cold' && (
        <PreviewEngine
          name="Cold lead chase"
          audience="Leads whose stage is Cold in the CRM (2,124 today)"
          hours="10am–7pm IST"
          steps={[
            { tpl: 'c1', after: 'Start' }, { tpl: 'c2', after: '+3 days' }, { tpl: 'c3', after: '+7 days' }, { tpl: 'c4', after: '+14 days' },
            { tpl: 'c5', after: '+21 days' }, { tpl: 'c6', after: '+40 days' }, { tpl: 'c7', after: '+70 days' }, { tpl: 'c8', after: '+90 days' },
          ]}
        />
      )}
      {engine === 'hot' && <NurtureEngine />}
    </div>
  );
}

/**
 * A DESIGN PREVIEW of an engine that is not built yet: the steps, timing and
 * exact approved wording, so the shape can be agreed before any code that can
 * send exists. Every control here is disabled on purpose.
 */
const templateBodyCache: Record<string, string> = {};

function PreviewEngine({ name, audience, hours, steps }: {
  name: string; audience: string; hours: string; steps: { tpl: string; after: string }[];
}) {
  const [bodies, setBodies] = useState<Record<string, string>>(() => ({ ...templateBodyCache }));
  const [open, setOpen] = useState<string | null>(steps[0]?.tpl ?? null);

  // Keyed on the template NAMES, not the array: the parent builds a fresh
  // array every render, and depending on it would refetch forever.
  const names = steps.map((x) => x.tpl).join(',');
  useEffect(() => {
    const supabase = createClient();
    supabase.from('relay_templates').select('name, body').in('name', names.split(',')).then(({ data }) => {
      for (const t of (data || []) as { name: string; body: string }[]) templateBodyCache[t.name] = t.body;
      setBodies({ ...templateBodyCache });
    });
  }, [names]);

  return (
    <>
      <div style={{ background: 'var(--amber-bg)', color: 'var(--amber)', padding: '10px 13px', borderRadius: 11, fontSize: 12.5, fontWeight: 600, marginBottom: 14, lineHeight: 1.5 }}>
        Design preview — {name} is not built yet. Nothing here can send; the switches are disabled.
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--ink-2)' }}>Who:</strong> {audience}<br />
              <strong style={{ color: 'var(--ink-2)' }}>When:</strong> {hours}, one message per person per day at most<br />
              <strong style={{ color: 'var(--ink-2)' }}>Stops:</strong> the moment they reply, the team messages them, their stage changes, or they say STOP
            </div>
          </div>
          <Switch on={false} disabled onClick={() => {}} label={name} />
        </div>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 0, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 14, paddingBottom: 2 }}>
        {steps.map((st, i) => (
          <div key={st.tpl} style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
            {i > 0 && <ChevronRight size={14} style={{ color: 'var(--muted)', margin: '0 2px' }} />}
            <button
              onClick={() => setOpen(st.tpl)}
              style={{
                textAlign: 'left', padding: '8px 12px', borderRadius: 11, cursor: 'pointer', minWidth: 74,
                border: '1px solid ' + (open === st.tpl ? 'var(--ink-2)' : 'var(--line)'),
                background: open === st.tpl ? 'var(--surface-3)' : 'var(--surface)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>{st.tpl.toUpperCase()}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{st.after}</div>
            </button>
          </div>
        ))}
      </div>

      {open && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{open.toUpperCase()}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{steps.find((x) => x.tpl === open)?.after} · template <code>{open}</code></span>
            <span style={{ marginLeft: 'auto' }}><Switch on={false} disabled onClick={() => {}} label={open} /></span>
          </div>
          <div style={{ padding: '11px 13px', borderRadius: 10, background: 'var(--surface-2)', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {(bodies[open] || 'Loading wording…').replace(/\{\{\s*1\s*\}\}/g, 'Name')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8, marginTop: 12, opacity: 0.55 }}>
            <Tile label="Sent today" value={0} />
            <Tile label="Last 7 days" value={0} />
            <Tile label="Delivered" value={0} />
            <Tile label="Replied" value={0} />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
            Once built, this step gets the same lists as the CV chase: Next up, Sent and Stopped.
          </div>
        </Card>
      )}
    </>
  );
}

// =============================================================================
// HOT & SPOTLIGHT NURTURE — the live tab. One switch, one cap, the HS1→HS8
// timeline with real wording, and the Next up / Paused / Sent / Stopped lists.
// Pause, Resume and Skip act through /api/automation/nurture, the same code
// the engine reads, so the tab and the sender can never disagree.
// =============================================================================
interface NurtureOverview {
  isAdmin: boolean;
  rule: { enabled: boolean; dailyCap: number };
  audience: { total: number; spotlight: number; paused: number };
  sentToday: number;
  steps: { key: string; template: string; body: string | null; sent: number }[];
  next: { phone: string; name: string | null; key: string; spotlight: boolean; at: string; state: string }[];
  sent: { phone: string; name: string | null; key: string; at: string }[];
  paused: { phone: string; name: string | null; spotlight: boolean }[];
  stopped: { phone: string; name: string | null; key: string; at: string; reason: string }[];
}

let nurtureCache: NurtureOverview | null = null;

function NurtureEngine() {
  const [ov, setOv] = useState<NurtureOverview | null>(nurtureCache);
  const [openStep, setOpenStep] = useState<string>('nurture_hs1');
  const [list, setList] = useState('next');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const res = await fetch('/api/automation/nurture', { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) { if (!quiet) setError(json.error || 'Could not load.'); return; }
      nurtureCache = json as NurtureOverview;
      setOv(nurtureCache);
      setError(null);
    } catch { if (!quiet) setError('Could not load — check your connection.'); }
  }, []);
  useEffect(() => {
    load(!!nurtureCache);
    const t = setInterval(() => load(true), 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey); setMsg(null);
    try {
      const res = await fetch('/api/automation/nurture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!json.ok) { setMsg({ ok: false, text: json.error || 'Could not save.' }); return false; }
      await load(true);
      return true;
    } catch { setMsg({ ok: false, text: 'Network error — nothing was changed.' }); return false; }
    finally { setBusy(null); }
  }

  if (!ov) {
    return error
      ? <Card><div style={{ color: 'var(--red)', fontSize: 12.5 }}>{error}</div></Card>
      : <Card><div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13, padding: '6px 0' }}><Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} /> Loading…</div></Card>;
  }

  const stepMeta = (k: string) => ({ n: Number(k.replace('nurture_hs', '')), tpl: k.replace('nurture_', '') });
  const fmtAt = (iso: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  const open = ov.steps.find((s) => s.key === openStep) ?? ov.steps[0];
  const lists = [
    { id: 'next', label: 'Next up', count: ov.next.length },
    { id: 'paused', label: 'Paused', count: ov.paused.length },
    { id: 'sent', label: 'Sent', count: ov.sent.length },
    { id: 'stopped', label: 'Stopped', count: ov.stopped.length },
  ];

  function toggleEngine() {
    const on = !ov!.rule.enabled;
    const text = on
      ? `Switch ON the Hot & Spotlight nurture?\n\nIt starts on the next run (within 5 minutes), 10am–7pm IST, up to ${ov!.rule.dailyCap || 'unlimited'} messages a day across HS1–HS8. ${ov!.audience.total} people are in the audience; only those quiet for 3+ days get anything.`
      : 'Switch OFF the nurture?\n\nNothing is lost: everyone continues from their next message when you switch it back on.';
    if (confirm(text)) post({ enabled: on }, 'switch');
  }

  return (
    <>
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Hot & Spotlight nurture</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: ov.rule.enabled ? 'var(--teal-bg)' : 'var(--surface-3)', color: ov.rule.enabled ? 'var(--teal-ink)' : 'var(--muted)' }}>
                {ov.rule.enabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
              Starts after 3 quiet days, then one message every 4 days, HS1 → HS8, 10am–7pm IST.
              A reply pauses it; the team talking pauses it; Won/Lost/Junk or STOP ends it. Spotlight goes first.
            </div>
          </div>
          <Switch on={ov.rule.enabled} disabled={!ov.isAdmin || busy === 'switch'} onClick={toggleEngine} label="Hot & Spotlight nurture" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line-2)', fontSize: 12.5, color: 'var(--muted)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Max per day
            <input
              inputMode="numeric"
              disabled={!ov.isAdmin || busy === 'switch'}
              value={capDraft ?? String(ov.rule.dailyCap)}
              onChange={(e) => setCapDraft(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => { if (capDraft !== null && capDraft !== String(ov.rule.dailyCap)) { const n = Number(capDraft); if (Number.isInteger(n) && n >= 0) post({ dailyCap: n }, 'switch'); } setCapDraft(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ width: 54, padding: '4px 6px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 12.5, textAlign: 'center', outline: 'none' }}
            />
          </label>
          <span>Audience <strong style={{ color: 'var(--ink-2)' }}>{ov.audience.total}</strong> · ★ {ov.audience.spotlight} · paused {ov.audience.paused}</span>
          <span>Sent today <strong style={{ color: 'var(--ink-2)' }}>{ov.sentToday}</strong></span>
          {!ov.isAdmin && <span>Only an admin can change these.</span>}
        </div>
      </Card>

      {/* the series */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 14, paddingBottom: 2 }}>
        {ov.steps.map((st, i) => (
          <div key={st.key} style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
            {i > 0 && <ChevronRight size={14} style={{ color: 'var(--muted)', margin: '0 2px' }} />}
            <button
              onClick={() => setOpenStep(st.key)}
              style={{
                textAlign: 'left', padding: '8px 12px', borderRadius: 11, cursor: 'pointer', minWidth: 72,
                border: '1px solid ' + (openStep === st.key ? 'var(--teal)' : 'var(--line)'),
                background: openStep === st.key ? 'var(--teal-bg)' : 'var(--surface)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: openStep === st.key ? 'var(--teal-ink)' : 'var(--ink)' }}>HS{stepMeta(st.key).n}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{i === 0 ? 'after 3 quiet days' : '+4 days'} · {st.sent} sent</div>
            </button>
          </div>
        ))}
      </div>

      {open && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12.5, color: 'var(--muted)' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>HS{stepMeta(open.key).n}</span>
            template <code>{open.template}</code> · sent to {open.sent} people so far
          </div>
          <div style={{ padding: '11px 13px', borderRadius: 10, background: 'var(--surface-2)', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {open.body || 'Wording not registered.'}
          </div>
        </Card>
      )}

      {msg && <div style={{ background: msg.ok ? 'var(--teal-bg)' : 'var(--red-bg)', color: msg.ok ? 'var(--teal-ink)' : 'var(--red)', padding: '9px 12px', borderRadius: 10, fontSize: 12.5, marginBottom: 12 }}>{msg.text}</div>}

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {lists.map((l) => (
            <button key={l.id} onClick={() => setList(l.id)}
              style={{ padding: '5px 11px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (list === l.id ? 'transparent' : 'var(--line)'), background: list === l.id ? 'var(--ink)' : 'transparent', color: list === l.id ? 'var(--surface)' : 'var(--ink-2)' }}>
              {l.label} <span style={{ opacity: 0.7 }}>{l.count}</span>
            </button>
          ))}
        </div>
        <div style={{ maxHeight: 440, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {list === 'next' && (ov.next.length === 0 ? <Empty text="Nobody is waiting right now." /> : ov.next.map((n) => (
            <Line key={n.phone + n.key} name={n.name ? (n.spotlight ? '★ ' + n.name : n.name) : n.phone} phone={n.phone}
              sub={n.state === 'due' ? `HS${stepMeta(n.key).n} — goes out on the next run (within the daily limit)`
                : n.state === 'off' ? `HS${stepMeta(n.key).n} — due, waiting for the switch`
                : n.state === 'paused' ? `HS${stepMeta(n.key).n} — paused by the team`
                : n.state === 'ecosystem' ? `HS${stepMeta(n.key).n} — Meta pause, earliest ${fmtAt(n.at)}`
                : n.state === 'silence' ? `HS${stepMeta(n.key).n} — waiting for 3 quiet days (they're talking to you)`
                : `HS${stepMeta(n.key).n} — scheduled ${fmtAt(n.at)}`}
              right={<span style={{ display: 'inline-flex', gap: 6 }}>
                {ov.isAdmin && n.state !== 'paused' && (
                  <button onClick={() => { if (confirm(`Skip HS${stepMeta(n.key).n} for ${n.name || n.phone}?\n\nThe series continues with the next message.`)) post({ action: 'skipStep', phone: n.phone, key: n.key }, n.phone); }} disabled={!!busy}
                    style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Skip</button>
                )}
                <button onClick={() => post({ action: n.state === 'paused' ? 'resume' : 'pause', phone: n.phone }, n.phone)} disabled={!!busy}
                  style={{ padding: '5px 10px', borderRadius: 8, border: 0, background: n.state === 'paused' ? 'var(--teal)' : 'var(--amber-bg)', color: n.state === 'paused' ? '#fff' : 'var(--amber)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>
                  {n.state === 'paused' ? 'Resume' : 'Pause'}
                </button>
              </span>}
            />
          )))}
          {list === 'paused' && (ov.paused.length === 0 ? <Empty text="Nobody is paused." /> : ov.paused.map((p) => (
            <Line key={p.phone} name={p.name ? (p.spotlight ? '★ ' + p.name : p.name) : p.phone} phone={p.phone} sub="Paused by the team — nothing sends until resumed"
              right={<button onClick={() => post({ action: 'resume', phone: p.phone }, p.phone)} disabled={!!busy}
                style={{ padding: '5px 10px', borderRadius: 8, border: 0, background: 'var(--teal)', color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Resume</button>}
            />
          )))}
          {list === 'sent' && (ov.sent.length === 0 ? <Empty text="Nothing sent yet." /> : ov.sent.map((x) => (
            <Line key={x.phone + x.key} name={x.name || x.phone} phone={x.phone} sub={`HS${stepMeta(x.key).n} · ${fmtAt(x.at)}`} right={<Chip tone="teal">Sent</Chip>} />
          )))}
          {list === 'stopped' && (ov.stopped.length === 0 ? <Empty text="Nobody has been stopped." /> : ov.stopped.map((x) => (
            <Line key={x.phone + x.key} name={x.name || x.phone} phone={x.phone} sub={`${x.reason} · ${fmtAt(x.at)}`} right={<Chip tone="grey">Stopped</Chip>} />
          )))}
        </div>
      </Card>
    </>
  );
}
