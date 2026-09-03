'use client';

// =============================================================================
// FOLLOW-UP SEQUENCE — the C1–C8 machine.
// -----------------------------------------------------------------------------
// Desktop: two columns — the LEFT tells you how it is going (status, results,
// delivery report, live feed), the RIGHT is how it is set up (messages, daily
// intake, sending hours). Phone: the same cards in one thumb-friendly column.
// The split is measured from the panel's own width, not the window, so it is
// right even when the browser pane is narrow.
//
// Config saves itself as you type; the engine reads fresh settings on every
// 2-minute pass. Counters refresh themselves while the page is open.
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Pause, Square, Plus, X, Loader2, CheckCircle2, MessageSquareReply,
  SkipForward, Users, Send, ListChecks, CalendarClock, Clock,
} from 'lucide-react';
import type { RelayTemplate } from '@/lib/messages';

interface Seq {
  id: string; name: string; audience: 'cold' | 'hot' | 'both';
  status: 'draft' | 'running' | 'paused' | 'stopped';
  trigger_mode?: 'backlog' | 'no_reply';
  industries?: string[] | null;
  hours_enabled: boolean; send_start_hour: number; send_end_hour: number;
  started_at: string | null;
}
interface SeqSummary { id: string; name: string; status: Seq['status']; trigger_mode: string }
interface Step { template_name: string; template_language: string; gap_hours: number }
interface RampRow { per_day: number; duration_days: number | null }
interface Stats {
  audienceTotal: number; pending: number; active: number; completed: number;
  replied: number; skipped: number; stopped: number;
  enrolledToday: number; intakeLimit: number; sentToday: number; rampDay: number;
  delivery: { sent: number; delivered: number; read: number; failed: number };
  failures?: { code: string; detail: string; hits: number }[];
}
interface Activity {
  id: string; lead_name: string; step_no: number; template_name: string;
  ok: boolean; error: string | null; sent_at: string;
}

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16,
  padding: 20, boxShadow: 'var(--shadow)',
};
const select: React.CSSProperties = {
  padding: '8px 11px', borderRadius: 9, border: '1px solid var(--line)',
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, outline: 'none', maxWidth: '100%',
};
const numInput: React.CSSProperties = { ...select, width: 62, textAlign: 'center' };
const sectionTitle: React.CSSProperties = { fontSize: 13.8, fontWeight: 700, color: 'var(--ink)' };
const addBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 11, padding: '8px 13px',
  borderRadius: 10, border: '1px dashed var(--line)', background: 'transparent',
  color: 'var(--muted)', fontSize: 12.4, fontWeight: 600, cursor: 'pointer',
};

export function SequencePanel({ templates }: { templates: RelayTemplate[] }) {
  const [seq, setSeq] = useState<Seq | null>(null);
  const [seqs, setSeqs] = useState<SeqSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [industryOptions, setIndustryOptions] = useState<{ value: string; count: number }[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [ramp, setRamp] = useState<RampRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [acting, setActing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Two columns when the PANEL is wide enough — measured, not guessed.
  // A callback ref, because the measured div only exists once loading is done;
  // a mount-time effect would run before it renders and observe nothing.
  const roRef = useRef<ResizeObserver | null>(null);
  const [wide, setWide] = useState(false);
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    setWide(el.clientWidth >= 860);
    roRef.current = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 860));
    roRef.current.observe(el);
  }, []);

  const load = useCallback(async (silent = false, id?: string | null) => {
    try {
      const want = id ?? selectedId;
      const res = await fetch('/api/automation/sequence' + (want ? `?id=${want}` : ''));
      const j = await res.json();
      if (!j.ok) { if (!silent) setLoadError(j.error); return; }
      setLoadError(null);
      setSeqs(j.sequences || []);
      setIndustryOptions(j.industryOptions || []);
      setSelectedId(j.sequence.id);
      setSeq((prev) => silent && prev && prev.id === j.sequence.id ? { ...j.sequence, ...{
        // While polling, keep whatever the user is mid-editing.
        audience: prev.audience, hours_enabled: prev.hours_enabled, industries: prev.industries,
        send_start_hour: prev.send_start_hour, send_end_hour: prev.send_end_hour,
      } } : j.sequence);
      setStats(j.stats);
      setActivity(j.activity || []);
      if (!silent) {
        setSteps(j.steps.map((s: Step & { gap_days?: number }) => ({
          template_name: s.template_name, template_language: s.template_language,
          gap_hours: s.gap_hours ?? (s.gap_days ?? 0) * 24,
        })));
        setRamp(j.ramp.map((r: RampRow) => ({ per_day: r.per_day, duration_days: r.duration_days })));
      }
    } catch { if (!silent) setLoadError('Could not reach the server.'); }
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  function queueSave(patch: { sequence?: Partial<Seq>; steps?: Step[]; ramp?: RampRow[] }) {
    setSaving('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/automation/sequence', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, id: seq?.id }),
        });
        setSaving((await res.json()).ok ? 'saved' : 'idle');
        setTimeout(() => setSaving('idle'), 1600);
      } catch { setSaving('idle'); }
    }, 600);
  }

  async function act(action: 'start' | 'pause' | 'resume' | 'stop') {
    if (!seq) return;
    setActing(true);
    try {
      const res = await fetch('/api/automation/sequence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id: seq.id }),
      });
      const j = await res.json();
      if (j.ok) { setSeq({ ...seq, status: j.status }); load(true); }
    } catch { /* pill stays as it was */ }
    setActing(false);
  }

  const chase = seq?.trigger_mode === 'no_reply';
  const gapWord = (h: number) => h % 24 === 0 && h >= 24 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`;

  const summary = useMemo(() => {
    if (!steps.length) return 'No messages configured yet.';
    if (chase) {
      const ladder = steps.map((st, i) =>
        `${st.template_name || '…'} after ${gapWord(st.gap_hours)}${i === 0 ? ' of the first message' : ''}`).join(', then ');
      return `Chases everyone who got the first message and stayed silent: ${ladder}.`;
    }
    const who = seq?.audience === 'both' ? 'cold and hot leads' : `${seq?.audience} leads`;
    const rampText = ramp
      .map((r, i) => r.duration_days == null || i === ramp.length - 1
        ? `then ${r.per_day}/day onwards` : `${r.per_day}/day for ${r.duration_days} days`)
      .join(', ')
      .replace(/^then /, '');
    return `Sends ${steps.length} message${steps.length === 1 ? '' : 's'} to ${who}, oldest first — ${rampText}.`;
  }, [steps, ramp, seq?.audience, chase]);

  if (loadError) {
    return <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{loadError}</div>;
  }
  if (!seq || !stats) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 60, color: 'var(--muted)', fontSize: 13.5 }}>
        <span><Loader2 size={15} className="animate-spin" style={{ verticalAlign: -3, marginRight: 8 }} />Loading…</span>
      </div>
    );
  }

  const running = seq.status === 'running';
  const covered = stats.completed + stats.replied + stats.skipped + stats.stopped;
  const progressPct = stats.audienceTotal > 0
    ? Math.min(100, Math.round(((covered + stats.active) / stats.audienceTotal) * 100)) : 0;
  const d = stats.delivery;
  const deliveredPct = d.sent > 0 ? Math.round((d.delivered / d.sent) * 100) : 0;
  const readPct = d.sent > 0 ? Math.round((d.read / d.sent) * 100) : 0;

  const STATUS_STYLE: Record<Seq['status'], { label: string; bg: string; fg: string }> = {
    draft:   { label: 'Not started', bg: 'var(--surface-2)', fg: 'var(--muted)' },
    running: { label: '● Running',   bg: 'rgba(37,211,102,.14)', fg: 'var(--green)' },
    paused:  { label: 'Paused',      bg: 'var(--amber-bg)', fg: '#B45309' },
    stopped: { label: 'Stopped',     bg: 'var(--red-bg)', fg: 'var(--red)' },
  };
  const st = STATUS_STYLE[seq.status];

  const btn = (primary: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 11,
    border: primary ? 'none' : '1px solid var(--line)',
    background: primary ? 'var(--green)' : 'var(--surface)',
    color: primary ? '#fff' : 'var(--ink)',
    fontSize: 13.4, fontWeight: 600, cursor: 'pointer',
  });

  // ── the cards, laid out per breakpoint below ──────────────────────────────

  const controlCard = (
    <section className="animate-pop-in" style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{seq.name}</div>
        <span style={{ fontSize: 11.4, fontWeight: 700, padding: '4px 11px', borderRadius: 20, background: st.bg, color: st.fg }}>
          {st.label}{running && stats.rampDay > 0 ? ` · day ${stats.rampDay}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: saving === 'saved' ? 'var(--green)' : 'var(--muted)' }}>
          {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved ✓' : ''}
        </span>
      </div>
      <div style={{ fontSize: 12.9, color: 'var(--muted)', lineHeight: 1.6, margin: '8px 0 16px', maxWidth: 640 }}>
        {summary} Anyone who replies leaves it immediately.
      </div>

      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
        {seq.status === 'draft' && (
          <button onClick={() => act('start')} disabled={acting || !steps.length} style={btn(true)}>
            {acting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start sequence
          </button>
        )}
        {running && (
          <>
            <button onClick={() => act('pause')} disabled={acting} style={btn(false)}><Pause size={14} /> Pause</button>
            <button onClick={() => act('stop')} disabled={acting} style={{ ...btn(false), color: 'var(--red)' }}><Square size={13} /> Stop</button>
          </>
        )}
        {(seq.status === 'paused' || seq.status === 'stopped') && (
          <>
            <button onClick={() => act('resume')} disabled={acting} style={btn(true)}>
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Resume
            </button>
            {seq.status === 'paused' && (
              <button onClick={() => act('stop')} disabled={acting} style={{ ...btn(false), color: 'var(--red)' }}><Square size={13} /> Stop</button>
            )}
          </>
        )}

        {!chase && <div style={{ marginLeft: 'auto', display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 11, padding: 3 }}>
          {(['cold', 'hot', 'both'] as const).map((aud) => (
            <button
              key={aud}
              onClick={() => { setSeq({ ...seq, audience: aud }); queueSave({ sequence: { audience: aud } }); }}
              style={{
                padding: '6px 14px', borderRadius: 8, border: 'none', fontSize: 12.3, fontWeight: 600,
                cursor: 'pointer', textTransform: 'capitalize',
                background: seq.audience === aud ? 'var(--surface)' : 'transparent',
                color: seq.audience === aud ? 'var(--ink)' : 'var(--muted)',
                boxShadow: seq.audience === aud ? 'var(--shadow)' : 'none',
                transition: 'background .15s',
              }}
            >
              {aud}
            </button>
          ))}
        </div>}
      </div>
    </section>
  );

  // ── which of the two machines is on screen ─────────────────────────────────
  const switcher = seqs.length > 1 && (
    <div style={{ display: 'inline-flex', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 3, boxShadow: 'var(--shadow)', alignSelf: 'flex-start' }}>
      {seqs.map((sq) => {
        const on = sq.id === seq.id;
        const runningDot = sq.status === 'running';
        return (
          <button
            key={sq.id}
            onClick={() => { if (!on) { setSeq(null); setStats(null); load(false, sq.id); } }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '8px 16px', borderRadius: 10, border: 'none', fontSize: 12.8, fontWeight: 600,
              cursor: 'pointer',
              background: on ? 'var(--green)' : 'transparent',
              color: on ? '#fff' : 'var(--muted)',
              transition: 'background .15s, color .15s',
            }}
          >
            {sq.trigger_mode === 'no_reply' ? '⏱ ' : '☰ '}{sq.name}
            {runningDot && !on && <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--green)' }} />}
          </button>
        );
      })}
    </div>
  );

  // ── who this may go to, by category ───────────────────────────────────────
  const chips = [...industryOptions, { value: '(none)', count: 0 }];
  const selectedInds = seq.industries && seq.industries.length ? seq.industries : null;
  const toggleIndustry = (val: string | null) => {
    let next: string[] | null;
    if (val === null) next = null;                                  // "everyone"
    else if (!selectedInds) next = [val];                           // first pick
    else if (selectedInds.includes(val)) {
      const rest = selectedInds.filter((x) => x !== val);
      next = rest.length ? rest : null;                             // last chip off = everyone
    } else next = [...selectedInds, val];
    setSeq({ ...seq, industries: next });
    queueSave({ sequence: { industries: next } });
  };
  const chipStyle = (on: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 20,
    border: '1px solid ' + (on ? 'var(--green)' : 'var(--line)'),
    background: on ? 'rgba(37,211,102,.12)' : 'var(--bg)',
    color: on ? 'var(--green)' : 'var(--muted)',
    fontSize: 12.3, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
  });

  const industriesCard = (
    <section style={{ ...card }}>
      <div style={{ ...sectionTitle, marginBottom: 3 }}>Which categories</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 13, lineHeight: 1.55 }}>
        Send only to the industries you pick. With none picked, everyone qualifies.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => toggleIndustry(null)} style={chipStyle(!selectedInds)}>Everyone</button>
        {chips.map((c) => {
          const on = !!selectedInds?.includes(c.value);
          return (
            <button key={c.value} onClick={() => toggleIndustry(c.value)} style={chipStyle(on)}>
              {c.value === '(none)' ? 'No industry set' : c.value}
              {c.count > 0 && <span style={{ fontSize: 10.5, opacity: .75 }}>{c.count}</span>}
            </button>
          );
        })}
      </div>
      {selectedInds && (
        <div style={{ fontSize: 11.6, color: 'var(--muted)', marginTop: 11 }}>
          Only <b style={{ color: 'var(--ink)' }}>{selectedInds.map((x) => x === '(none)' ? 'no-industry' : x).join(', ')}</b> leads will be messaged; every other category is left alone.
        </div>
      )}
    </section>
  );

  const resultsCard = (
    <section style={{ ...card }}>
      <div style={{ ...sectionTitle, marginBottom: 14 }}>Leads</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Tile icon={<Users size={14} />} label={chase ? 'Messaged' : 'Waiting'} value={chase ? stats.audienceTotal : stats.pending} hint={chase ? 'got the first message in the last 14 days' : 'in the audience, not yet enrolled'} />
        <Tile icon={<Send size={14} />} label="Active" value={stats.active} tint="var(--green)" hint="enrolled, receiving messages" />
        <Tile icon={<MessageSquareReply size={14} />} label="Replied" value={stats.replied} tint="#2E9BFF" hint="answered — sequence stopped for them" />
        <Tile icon={<CheckCircle2 size={14} />} label="Completed" value={stats.completed} hint="got every message" />
        <Tile icon={<SkipForward size={14} />} label="Skipped" value={stats.skipped + stats.stopped} tint="var(--red)" hint="failed number, or opted out" />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.8, color: 'var(--muted)', marginBottom: 6 }}>
        <span>{chase
          ? `${covered + stats.active} of ${stats.audienceTotal.toLocaleString()} silent leads picked up`
          : `${covered + stats.active} of ${stats.audienceTotal.toLocaleString()} leads reached · oldest first`}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{progressPct}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 5, background: 'var(--surface-3)', border: '1px solid var(--line)', overflow: 'hidden' }}>
        <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--green)', transition: 'width .5s' }} />
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 11 }}>
        Today: <b style={{ color: 'var(--ink)' }}>{stats.enrolledToday}</b> of {stats.intakeLimit} new leads added
        · <b style={{ color: 'var(--ink)' }}>{stats.sentToday}</b> message{stats.sentToday === 1 ? '' : 's'} sent
      </div>
    </section>
  );

  const deliveryCard = (
    <section style={{ ...card }}>
      <div style={{ ...sectionTitle, marginBottom: 3 }}>Delivery report</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
        Live WhatsApp receipts across every message this sequence has sent.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Tile icon={<Send size={14} />} label="Sent" value={d.sent} hint="accepted by WhatsApp" />
        <Tile icon={<CheckCircle2 size={14} />} label="Delivered" value={d.delivered} tint="var(--green)" hint="reached their phone" />
        <Tile icon={<CheckCircle2 size={14} />} label="Read" value={d.read} tint="#2E9BFF" hint="blue ticks" />
        <Tile icon={<X size={14} />} label="Bounced" value={d.failed} tint="var(--red)" hint="rejected or undeliverable" />
      </div>

      <FunnelBar label="Delivered" pct={deliveredPct} color="var(--green)" />
      <FunnelBar label="Read" pct={readPct} color="#2E9BFF" />
      <div style={{ fontSize: 11.4, color: 'var(--muted)', marginTop: 8 }}>
        {d.sent === 0 ? 'Receipts appear here as soon as the first messages go out.'
          : `${deliveredPct}% of sent messages reached the phone · ${readPct}% were read.`}
      </div>

      {/* A bounce count on its own tells you nothing. Meta's 131049 means the
          marketing frequency cap — slow down or move to UTILITY templates —
          which is a different problem from a dead number. */}
      {!!stats.failures?.length && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 11 }}>
          <div style={{ fontSize: 11.6, fontWeight: 700, color: 'var(--ink)', marginBottom: 7 }}>Why they bounced</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {stats.failures.map((f) => (
              <div key={f.code + f.detail} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11.5, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 700, color: 'var(--red)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{f.hits}×</span>
                <span style={{ color: 'var(--muted)' }}>
                  {/^131049$/.test(f.code)
                    ? 'Meta held it back — this person has had too many marketing messages lately. Slow the daily rate, or use a UTILITY template.'
                    : f.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );

  const messagesCard = (
    <section style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <ListChecks size={15} style={{ color: 'var(--green)' }} />
        <span style={sectionTitle}>Messages, in order</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
        Approved templates, sent with the lead&rsquo;s first name filled in.
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {steps.map((stp, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 11, padding: '9px 12px' }}>
            <span style={{ width: 28, height: 24, display: 'grid', placeItems: 'center', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 11.5, fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>
              {i + 1}
            </span>
            <select
              style={{ ...select, flex: 1, minWidth: 120 }}
              value={stp.template_name}
              onChange={(e) => {
                const t = templates.find((x) => x.name === e.target.value);
                const next = steps.map((x, j) => j === i ? { ...x, template_name: e.target.value, template_language: t?.language || 'en' } : x);
                setSteps(next); queueSave({ steps: next });
              }}
            >
              <option value="">— template —</option>
              {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
            {/* One number, one unit. Hours exist for the no-reply chase
                ("T2 four hours after the first message"); days for the slow
                backlog drip. Either way the stored value is hours. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
              {(() => {
                const inDays = stp.gap_hours % 24 === 0 && stp.gap_hours >= 24;
                const shown = inDays ? stp.gap_hours / 24 : stp.gap_hours;
                const setGap = (n: number, days: boolean) => {
                  const hours = Math.max(0, Math.min(24 * 90, days ? n * 24 : n));
                  const next = steps.map((x, j) => j === i ? { ...x, gap_hours: hours } : x);
                  setSteps(next); queueSave({ steps: next });
                };
                return (
                  <>
                    <input
                      type="number" min={0} max={inDays ? 90 : 2160} style={numInput} value={shown}
                      onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0), inDays)}
                    />
                    <select
                      style={{ ...select, padding: '7px 8px' }}
                      value={inDays ? 'days' : 'hours'}
                      onChange={(e) => setGap(shown, e.target.value === 'days')}
                    >
                      <option value="hours">hour{shown === 1 ? '' : 's'}</option>
                      <option value="days">day{shown === 1 ? '' : 's'}</option>
                    </select>
                    {i === 0 ? (chase ? 'after the first message' : 'after they join') : 'after the previous one'}
                  </>
                );
              })()}
            </span>
            <button
              onClick={() => { const next = steps.filter((_, j) => j !== i); setSteps(next); queueSave({ steps: next }); }}
              aria-label={`Remove message ${i + 1}`}
              style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <button onClick={() => setSteps([...steps, { template_name: '', template_language: 'en', gap_hours: chase ? 8 : 72 }])} style={addBtn}>
        <Plus size={13} /> Add a message
      </button>
    </section>
  );

  const intakeCard = (
    <section style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <CalendarClock size={15} style={{ color: 'var(--green)' }} />
        <span style={sectionTitle}>New leads per day</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
        Start slow and ramp up — protects your number&rsquo;s quality rating.
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {ramp.map((r, i) => {
          const last = i === ramp.length - 1;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', fontSize: 12.6, color: 'var(--ink)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 11, padding: '9px 12px' }}>
              <input
                type="number" min={1} max={1000} style={{ ...numInput, width: 74 }} value={r.per_day}
                onChange={(e) => {
                  const next = ramp.map((x, j) => j === i ? { ...x, per_day: Math.max(1, Number(e.target.value) || 1) } : x);
                  setRamp(next); queueSave({ ramp: next });
                }}
              />
              <span>/day</span>
              {last ? <span style={{ color: 'var(--muted)' }}>from then on</span> : (
                <>
                  <span>for</span>
                  <input
                    type="number" min={1} max={365} style={numInput} value={r.duration_days ?? 10}
                    onChange={(e) => {
                      const next = ramp.map((x, j) => j === i ? { ...x, duration_days: Math.max(1, Number(e.target.value) || 1) } : x);
                      setRamp(next); queueSave({ ramp: next });
                    }}
                  />
                  <span>days</span>
                </>
              )}
              {ramp.length > 1 && (
                <button
                  onClick={() => {
                    const next: RampRow[] = ramp.filter((_, j) => j !== i)
                      .map((x, j, arr) => j === arr.length - 1 ? { ...x, duration_days: null } : { ...x, duration_days: x.duration_days ?? 10 });
                    setRamp(next); queueSave({ ramp: next });
                  }}
                  aria-label={`Remove stage ${i + 1}`}
                  style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        onClick={() => {
          const next: RampRow[] = ramp.map((x) => ({ ...x, duration_days: x.duration_days ?? 10 }));
          next.push({ per_day: (ramp[ramp.length - 1]?.per_day || 100) + 50, duration_days: null });
          setRamp(next); queueSave({ ramp: next });
        }}
        style={addBtn}
      >
        <Plus size={13} /> Add a stage
      </button>
    </section>
  );

  const hoursCard = (
    <section style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Clock size={15} style={{ color: 'var(--green)' }} />
        <span style={sectionTitle}>Sending hours</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
          <input
            type="checkbox" checked={seq.hours_enabled}
            onChange={(e) => { setSeq({ ...seq, hours_enabled: e.target.checked }); queueSave({ sequence: { hours_enabled: e.target.checked } }); }}
            style={{ width: 16, height: 16, accentColor: 'var(--green)' }}
          />
          <span style={{ fontSize: 12.8, fontWeight: 600, color: 'var(--ink)' }}>Only between</span>
        </label>
        <select
          style={select} disabled={!seq.hours_enabled} value={seq.send_start_hour}
          onChange={(e) => { const v = Number(e.target.value); setSeq({ ...seq, send_start_hour: v }); queueSave({ sequence: { send_start_hour: v } }); }}
        >
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>and</span>
        <select
          style={select} disabled={!seq.hours_enabled} value={seq.send_end_hour}
          onChange={(e) => { const v = Number(e.target.value); setSeq({ ...seq, send_end_hour: v }); queueSave({ sequence: { send_end_hour: v } }); }}
        >
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
        </select>
        <span style={{ fontSize: 11.6, color: 'var(--muted)' }}>IST</span>
      </div>
    </section>
  );

  const activityCard = (
    <section style={{ ...card }}>
      <div style={{ ...sectionTitle, marginBottom: 12 }}>Recent sends</div>
      {activity.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Nothing sent yet — press Start and the first messages go out within 2 minutes (inside sending hours).
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {activity.map((row) => (
            <div key={row.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.6, lineHeight: 1.5, borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <span style={{ color: row.ok ? 'var(--green)' : 'var(--red)', fontWeight: 700, flexShrink: 0 }}>{row.ok ? '✓' : '✕'}</span>
              <span style={{ color: 'var(--ink)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{row.lead_name}</span>
              <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                message {row.step_no} · {row.template_name}{row.error ? ` — ${row.error.slice(0, 60)}` : ''}
              </span>
              <span style={{ color: 'var(--muted)', marginLeft: 'auto', flexShrink: 0, fontSize: 11.4 }}>
                {new Date(row.sent_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  // ── layout ────────────────────────────────────────────────────────────────
  // Two INDEPENDENT columns, not a grid with shared rows. Grid rows tie the
  // height of a left card to whatever sits beside it, which is what left
  // "Recent sends" stranded under a column of empty space. Each column now
  // packs its own cards tightly and ends where its content ends.
  //
  //   left  = how it is going   (status -> numbers -> delivery -> what it did)
  //   right = how it is set up  (messages -> intake -> hours)
  const col: React.CSSProperties = {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16,
  };

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {switcher}
      {controlCard}

      {wide ? (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={col}>
            {resultsCard}
            {deliveryCard}
            {activityCard}
          </div>
          <div style={col}>
            {messagesCard}
            {industriesCard}
            {intakeCard}
            {hoursCard}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {resultsCard}
          {messagesCard}
          {industriesCard}
          {intakeCard}
          {hoursCard}
          {deliveryCard}
          {activityCard}
        </div>
      )}
    </div>
  );
}

function Tile({ icon, label, value, tint, hint }: {
  icon: React.ReactNode; label: string; value: number; tint?: string; hint: string;
}) {
  return (
    <div title={hint} style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 12px', cursor: 'default', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.2, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        <span style={{ color: tint || 'var(--muted)', display: 'inline-flex', flexShrink: 0 }}>{icon}</span> {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: tint || 'var(--ink)', marginTop: 3, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function FunnelBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
      <span style={{ fontSize: 11.4, fontWeight: 600, color: 'var(--muted)', width: 62, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 7, borderRadius: 4, background: 'var(--surface-3)', border: '1px solid var(--line)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .5s' }} />
      </div>
      <span style={{ fontSize: 11.4, fontWeight: 700, color: 'var(--ink)', width: 38, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
    </div>
  );
}
