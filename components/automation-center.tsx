'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw, RotateCw, MessageSquare } from 'lucide-react';

/**
 * SETTINGS → AUTOMATION. One tab per step of the CV/LinkedIn chase.
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

export function AutomationCenter({ onOpenChat }: { onOpenChat?: (key: string) => void }) {
  const [tab, setTab] = useState<Key>('new_lead_first');
  const [data, setData] = useState<Partial<Record<Key, Overview>>>({});
  const [onMap, setOnMap] = useState<Partial<Record<Key, boolean>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (k: Key) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automation/overview?key=${k}`, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not load.'); return; }
      setData((d) => ({ ...d, [k]: json as Overview }));
      setOnMap((m) => ({ ...m, [k]: !!json.rule?.enabled }));
    } catch {
      setError('Could not load — check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  // The tab dots: one light call for all five switches.
  const loadSwitches = useCallback(async () => {
    try {
      const res = await fetch('/api/automation/switch', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) setOnMap(Object.fromEntries((json.rules as { key: Key; enabled: boolean }[]).map((r) => [r.key, r.enabled])));
    } catch { /* dots are decoration */ }
  }, []);

  useEffect(() => { loadSwitches(); }, [loadSwitches]);
  useEffect(() => {
    load(tab);
    const t = setInterval(() => load(tab), 60_000);
    return () => clearInterval(t);
  }, [tab, load]);

  const meta = TABS.find((t) => t.key === tab)!;
  const ov = data[tab];

  return (
    <div>
      {/* ---- the tabs ---- */}
      <div role="tablist" style={{ display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 14, paddingBottom: 2 }}>
        {TABS.map((t) => {
          const active = t.key === tab;
          const on = onMap[t.key];
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, flex: 'none',
                padding: '8px 14px', borderRadius: 99, cursor: 'pointer',
                border: '1px solid ' + (active ? 'transparent' : 'var(--line)'),
                background: active ? 'var(--teal)' : 'var(--surface)',
                color: active ? '#fff' : 'var(--ink-2)', fontSize: 13, fontWeight: 600,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: on === undefined ? 'var(--line)' : on ? (active ? '#fff' : 'var(--teal)') : (active ? 'rgba(255,255,255,.45)' : 'var(--muted)'), opacity: on ? 1 : 0.6 }} />
              {t.label}
            </button>
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
          onReload={() => { load(tab); loadSwitches(); }}
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
