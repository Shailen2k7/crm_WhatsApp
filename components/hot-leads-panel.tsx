'use client';

// =============================================================================
// HOT LEADS — its own machine, with the whole life cycle on one screen.
// -----------------------------------------------------------------------------
// WHY THIS IS SEPARATE FROM THE C1–C8 PAGE
//
// Hot leads were being missed, and the reason was not a bug. Both existing
// machines said audience 'both' and both looked healthy. But C1–C8 enrols
// oldest lead first, and hot leads are the newest, so 47 of them sat at queue
// position 1000+ while the machine was at 292. Meanwhile the no-reply chase
// can only take people who never replied, and a hot lead replied. They fell in
// the gap between two healthy-looking machines.
//
// So this page is built around the one question that would have caught it:
//
//     HAVE WE MESSAGED EVERY SINGLE HOT LEAD, AND IF NOT, WHO AND WHY?
//
// EVERY BUTTON ANSWERS
//
// The first version of this page had a Start button that gave no sign it had
// been pressed: no spinner, the status pill did not move until a slow reload
// finished, and an error landed in small text below the fold. The server was
// fine — the person could not tell. So now:
//
//   * the status pill flips the instant you click (and flips back on failure)
//   * the button you pressed shows a spinner; every other button waits
//   * the result — success or the exact reason it failed — is a banner right
//     under the buttons, and it stays until the next action
//   * a running machine shows Pause and Stop; it can never show Start
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  Play, Pause, Square, Trash2, Zap, Send, Loader2, AlertTriangle,
  CheckCircle2, Clock, Users, X, Plus, Info,
} from 'lucide-react';
import type { RelayTemplate } from '@/lib/messages';

interface Seq {
  id: string; name: string; audience: 'cold' | 'hot' | 'both';
  status: 'draft' | 'running' | 'paused' | 'stopped';
  trigger_mode?: 'backlog' | 'no_reply';
  hours_enabled: boolean; send_start_hour: number; send_end_hour: number;
  started_at: string | null;
}
interface Step { template_name: string; template_language: string; gap_hours: number }
interface Coverage {
  applicable: boolean;
  total: number; messaged: number; waiting: number; queued: number;
  exitedTotal: number; covered: number; unreachableTotal: number; stillToGo: number;
  exited: { replied: number; completed: number; stopped: number; skipped: number };
  unreachable: Record<string, { id: string; name: string; phone: string | null }[]>;
  unreachableCounts: Record<string, number>;
}
interface Activity {
  id: string; lead_name: string; step_no: number; template_name: string;
  ok: boolean; error: string | null; sent_at: string;
}
type Tone = 'ok' | 'error' | 'info' | 'warn';
interface Banner { tone: Tone; text: string }

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16,
  padding: 20, boxShadow: 'var(--shadow)', marginBottom: 14,
};
const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px',
  borderRadius: 10, border: '1px solid var(--line)', background: 'transparent',
  color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  transition: 'opacity .15s, background .15s',
};
const sel: React.CSSProperties = {
  padding: '8px 11px', borderRadius: 9, border: '1px solid var(--line)',
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, outline: 'none', maxWidth: '100%',
};
const num: React.CSSProperties = { ...sel, width: 66, textAlign: 'center' };
const title: React.CSSProperties = { fontSize: 13.8, fontWeight: 700, color: 'var(--ink)' };
const spin: React.CSSProperties = { animation: 'spin .8s linear infinite' };

const TONE: Record<Tone, { bg: string; fg: string; border: string; Icon: typeof Info }> = {
  ok:    { bg: 'var(--green-bg)', fg: 'var(--green)', border: 'var(--green)', Icon: CheckCircle2 },
  error: { bg: 'rgba(239,68,68,.10)', fg: 'var(--red)', border: 'var(--red)', Icon: AlertTriangle },
  warn:  { bg: 'rgba(217,119,6,.12)', fg: '#D97706', border: '#D97706', Icon: AlertTriangle },
  info:  { bg: 'var(--bg)', fg: 'var(--muted)', border: 'var(--line)', Icon: Info },
};

const UNREACHABLE_LABELS: Record<string, string> = {
  noPhone: 'No phone number on the lead',
  badPhone: 'Phone number cannot be dialled',
  optedOut: 'Opted out of messages',
  busyElsewhere: 'Mid-way through another machine',
  industryFiltered: 'Excluded by the industry filter',
};

const STATUS_LABEL: Record<Seq['status'], string> = {
  draft: 'Not started', running: 'Running', paused: 'Paused', stopped: 'Stopped',
};

export function HotLeadsPanel({ templates }: { templates: RelayTemplate[] }) {
  const [seq, setSeq] = useState<Seq | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [perDay, setPerDay] = useState(25);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openBucket, setOpenBucket] = useState<string | null>(null);

  // ── load ────────────────────────────────────────────────────────────────
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBanner(null);
    try {
      const lr = await fetch('/api/automation/sequence?list=1', { cache: 'no-store' });
      const lj = await lr.json();
      if (!lj.ok) { setSeq(null); setLoading(false); return; }

      const list: { id: string; audience: string; trigger_mode: string }[] = lj.sequences || [];
      const mine = list.find((s) => s.audience === 'hot' && (s.trigger_mode || 'backlog') === 'backlog');
      if (!mine) { setSeq(null); setCov(null); setLoading(false); return; }

      const [jj, cj] = await Promise.all([
        fetch(`/api/automation/sequence?id=${mine.id}`, { cache: 'no-store' }).then((x) => x.json()),
        fetch(`/api/automation/coverage?id=${mine.id}`, { cache: 'no-store' }).then((x) => x.json()),
      ]);
      if (!jj.ok) { setSeq(null); setLoading(false); return; }

      setSeq(jj.sequence);
      setSteps((jj.steps || []).map((x: { template_name: string; template_language?: string; gap_hours?: number; gap_days?: number }) => ({
        template_name: x.template_name,
        template_language: x.template_language || 'en',
        gap_hours: x.gap_hours ?? (x.gap_days ?? 0) * 24,
      })));
      setPerDay(jj.ramp?.[0]?.per_day ?? 25);
      setActivity(jj.activity || []);
      setCov(cj.ok && cj.applicable ? cj : null);
    } catch {
      setBanner({ tone: 'error', text: 'Could not load this page. Check the connection and try again.' });
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!seq || seq.status !== 'running') return;
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
  }, [seq, load]);

  // ── life cycle: optimistic, with the truth restored on failure ───────────
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (acting) return;
    setActing(action); setBanner(null);

    // The pill flips NOW. If the server disagrees, it flips back below.
    const before = seq;
    const optimistic: Partial<Record<string, Seq['status']>> = {
      start: 'running', resume: 'running', pause: 'paused', stop: 'stopped',
    };
    if (seq && optimistic[action]) setSeq({ ...seq, status: optimistic[action]! });

    try {
      const r = await fetch('/api/automation/sequence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: seq?.id, ...extra }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `Server replied ${r.status} with no detail.` }));

      if (!j.ok) {
        setSeq(before);
        setBanner({ tone: 'error', text: j.error || `That did not work (HTTP ${r.status}).` });
      } else {
        const said: Record<string, string> = {
          start: 'Started. The engine picks it up on its next pass, within 2 minutes.',
          resume: 'Resumed. Everyone waiting continues from where they were.',
          pause: 'Paused. Nobody is messaged until you resume.',
          stop: 'Stopped.',
          release_now: `${j.released ?? 0} message${j.released === 1 ? '' : 's'} released to go now.`,
          enrol_all: `${j.enrolled ?? 0} lead${j.enrolled === 1 ? '' : 's'} added to the queue.`,
          delete: 'Deleted.',
          create: 'Created, switched off. Press Start when you are ready.',
        };
        setBanner({ tone: 'ok', text: said[action] || 'Done.' });
        if (action === 'delete') { setSeq(null); setCov(null); }
        await load(true);
      }
    } catch {
      setSeq(before);
      setBanner({ tone: 'error', text: 'Could not reach the server. Nothing was changed.' });
    }
    setActing(null); setConfirmDelete(false);
  };

  // ── config: the PATCH route reads sequence fields under `sequence` ───────
  // Sending them at the top level is accepted and silently ignored — that is
  // how the sending-hours switch on the first version of this page never
  // saved anything. steps and ramp are top-level on purpose.
  const patch = async (body: Record<string, unknown>) => {
    if (!seq) return;
    setSaveState('saving');
    try {
      const r = await fetch('/api/automation/sequence', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: seq.id, ...body }),
      });
      const j = await r.json().catch(() => ({ ok: false }));
      setSaveState(j.ok ? 'saved' : 'failed');
      if (!j.ok) setBanner({ tone: 'error', text: j.error || 'That change did not save.' });
      await load(true);
    } catch { setSaveState('failed'); }
    setTimeout(() => setSaveState('idle'), 1800);
  };
  const saveSeq   = (fields: Partial<Seq>) => { if (seq) setSeq({ ...seq, ...fields }); return patch({ sequence: fields }); };
  const saveSteps = (next: Step[]) => { setSteps(next); return patch({ steps: next }); };
  const saveRamp  = (n: number) => patch({ ramp: [{ per_day: n, duration_days: null }] });

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
      <Loader2 size={16} style={{ ...spin, verticalAlign: -3, marginRight: 8 }} />Loading…
    </div>;
  }

  // ── nothing yet ─────────────────────────────────────────────────────────
  if (!seq) {
    return (
      <div style={card}>
        <div style={{ ...title, fontSize: 16, marginBottom: 6 }}>No hot lead machine yet</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.65, margin: '0 0 8px' }}>
          Hot leads are people who already spoke to you. They should not get the C1–C8 copy,
          which is written for someone who went quiet. This creates a separate machine with
          its own four messages and its own pacing.
        </p>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.65, margin: '0 0 16px' }}>
          It is created switched <b style={{ color: 'var(--ink)' }}>off</b>. Nothing sends until you press Start.
        </p>
        <BannerLine b={banner} />
        <button
          onClick={() => act('create', { name: 'Hot leads follow-up', audience: 'hot', per_day: 25 })}
          disabled={!!acting}
          style={{ ...btn, background: 'var(--green)', color: '#fff', borderColor: 'transparent', marginTop: banner ? 12 : 0 }}
        >
          {acting === 'create' ? <Loader2 size={15} style={spin} /> : <Plus size={15} />}
          {acting === 'create' ? 'Creating…' : 'Create the hot machine'}
        </button>
      </div>
    );
  }

  const running = seq.status === 'running';
  const pct = cov && cov.total > 0 ? Math.round((cov.messaged / cov.total) * 100) : 0;
  const day = seq.started_at ? Math.floor((Date.now() - new Date(seq.started_at).getTime()) / 86_400_000) + 1 : 0;
  const statusColor = running ? 'var(--green)' : seq.status === 'paused' ? '#D97706' : seq.status === 'stopped' ? 'var(--red)' : 'var(--muted)';

  // Templates the steps name that Relay does not have yet. Sends still go out —
  // Interakt holds the approved wording — but the chat thread shows the code
  // instead of the text until Templates → Fetch templates has run.
  const missing = steps.map((s) => s.template_name).filter((n) => !templates.some((t) => t.name === n));

  const ActionBtn = ({ id, label, busyLabel, icon, style: extraStyle, danger }: {
    id: string; label: string; busyLabel: string; icon: React.ReactNode; style?: React.CSSProperties; danger?: boolean;
  }) => {
    const busy = acting === id;
    return (
      <button
        onClick={() => act(id)}
        disabled={!!acting}
        title={acting && !busy ? 'Wait for the current action to finish' : undefined}
        style={{ ...btn, ...(danger ? { color: 'var(--red)' } : {}), ...(extraStyle || {}), opacity: acting && !busy ? 0.5 : 1 }}
      >
        {busy ? <Loader2 size={15} style={spin} /> : icon}
        {busy ? busyLabel : label}
      </button>
    );
  };

  return (
    <div>
      {/* ── header + life cycle ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ ...title, fontSize: 17 }}>{seq.name}</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
            border: `1px solid ${statusColor}`, color: statusColor, fontSize: 12, fontWeight: 700,
            transition: 'color .2s, border-color .2s',
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: statusColor, ...(running ? { animation: 'pulse 1.6s ease-in-out infinite' } : {}) }} />
            {STATUS_LABEL[seq.status]}{running && day > 0 && ` · day ${day}`}
          </span>
          {/* The pressed button disappears the instant the status flips (a running
              machine must not show Start), so this is where the "still working"
              signal lives for the second the request takes to finish. */}
          {acting && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <Loader2 size={13} style={spin} /> Working…
            </span>
          )}
          {saveState !== 'idle' && (
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: saveState === 'failed' ? 'var(--red)' : 'var(--muted)' }}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Not saved'}
            </span>
          )}
        </div>
        <p style={{ fontSize: 12.8, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 15px' }}>
          Sends {steps.length} message{steps.length === 1 ? '' : 's'} to hot leads, {perDay}/day
          {seq.hours_enabled ? `, between ${seq.send_start_hour}:00 and ${seq.send_end_hour}:00 IST` : ', any time of day'}.
          Anyone who replies leaves immediately.
        </p>

        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {/* Exactly one primary verb per state. A running machine cannot show Start. */}
          {seq.status === 'draft'   && <ActionBtn id="start"  label="Start"       busyLabel="Starting…"  icon={<Play size={15} />}  style={{ background: 'var(--green)', color: '#fff', borderColor: 'transparent' }} />}
          {seq.status === 'stopped' && <ActionBtn id="start"  label="Start again" busyLabel="Starting…"  icon={<Play size={15} />}  style={{ background: 'var(--green)', color: '#fff', borderColor: 'transparent' }} />}
          {seq.status === 'paused'  && <ActionBtn id="resume" label="Resume"      busyLabel="Resuming…"  icon={<Play size={15} />}  style={{ background: 'var(--green)', color: '#fff', borderColor: 'transparent' }} />}
          {seq.status === 'running' && <ActionBtn id="pause"  label="Pause"       busyLabel="Pausing…"   icon={<Pause size={15} />} />}
          {(seq.status === 'running' || seq.status === 'paused') &&
            <ActionBtn id="stop" label="Stop" busyLabel="Stopping…" icon={<Square size={14} />} danger />}

          <ActionBtn id="enrol_all"   label="Queue everyone now" busyLabel="Queueing…"  icon={<Zap size={15} />} style={{ borderColor: 'var(--green)', color: 'var(--green)' }} />
          <ActionBtn id="release_now" label="Send waiting now"   busyLabel="Releasing…" icon={<Send size={14} />} />

          <div style={{ flex: 1 }} />

          {confirmDelete ? (
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <span style={{ fontSize: 12.3, color: 'var(--muted)' }}>Delete it and its history?</span>
              <button onClick={() => act('delete')} disabled={!!acting}
                style={{ ...btn, background: 'var(--red)', color: '#fff', borderColor: 'transparent' }}>
                {acting === 'delete' ? <Loader2 size={14} style={spin} /> : null}
                {acting === 'delete' ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button onClick={() => setConfirmDelete(false)} disabled={!!acting} style={{ ...btn, padding: '9px 11px' }}><X size={14} /></button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} disabled={!!acting || running}
              title={running ? 'Stop it before deleting' : undefined}
              style={{ ...btn, color: 'var(--muted)', opacity: running ? 0.45 : 1 }}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>

        <BannerLine b={banner} style={{ marginTop: 13 }} />

        {missing.length > 0 && (
          <BannerLine
            style={{ marginTop: banner ? 8 : 13 }}
            b={{ tone: 'warn', text:
              `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in Relay yet. ` +
              `Open Templates and press Fetch templates (or add ${missing.length === 1 ? 'it' : 'them'} by hand). ` +
              `Messages still go out — Interakt has the approved wording — but the chat thread will show the template code instead of the text until then.` }}
          />
        )}
      </div>

      {/* ── coverage: the point of the page ─────────────────────────────── */}
      {cov && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
            <Users size={15} style={{ color: 'var(--muted)' }} />
            <span style={title}>Coverage</span>
            <span style={{ marginLeft: 'auto', fontSize: 12.4, color: 'var(--muted)' }}>{cov.messaged} of {cov.total} messaged</span>
          </div>
          <div style={{ height: 9, borderRadius: 99, background: 'var(--bg)', overflow: 'hidden', margin: '12px 0 14px', border: '1px solid var(--line)' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)', transition: 'width .4s' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
            <Tile label="Messaged" value={cov.messaged} tone="var(--green)" />
            <Tile label="Queued, not sent" value={cov.waiting} />
            <Tile label="Left the sequence" value={cov.exitedTotal} />
            <Tile label="Still to go" value={cov.stillToGo} tone={cov.stillToGo > 0 ? '#D97706' : undefined} />
            <Tile label="Cannot be reached" value={cov.unreachableTotal} tone={cov.unreachableTotal > 0 ? 'var(--red)' : undefined} />
          </div>

          <div style={{ marginTop: 14, padding: '11px 13px', borderRadius: 11, background: 'var(--bg)', border: '1px solid var(--line)', fontSize: 12.7, color: 'var(--muted)', lineHeight: 1.6 }}>
            {cov.stillToGo === 0 && cov.unreachableTotal === 0 ? (
              <><CheckCircle2 size={13} style={{ verticalAlign: -2, color: 'var(--green)' }} />{' '}
              Every hot lead is accounted for. Nobody is waiting and nobody is unreachable.</>
            ) : cov.stillToGo === 0 ? (
              <><CheckCircle2 size={13} style={{ verticalAlign: -2, color: 'var(--green)' }} />{' '}
              Everyone the machine can reach is in it. The {cov.unreachableTotal} below need a person to fix something before they can be messaged.</>
            ) : (
              <><Clock size={13} style={{ verticalAlign: -2, color: '#D97706' }} />{' '}
              <b style={{ color: 'var(--ink)' }}>{cov.stillToGo}</b> reachable lead{cov.stillToGo === 1 ? ' is' : 's are'} not in the queue yet.
              At {perDay}/day that is {Math.ceil(cov.stillToGo / Math.max(1, perDay))} more day{Math.ceil(cov.stillToGo / Math.max(1, perDay)) === 1 ? '' : 's'},
              or press &ldquo;Queue everyone now&rdquo; to add them all at once.</>
            )}
            {!running && cov.waiting > 0 && (
              <div style={{ marginTop: 6 }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2, color: '#D97706' }} />{' '}
                <b style={{ color: 'var(--ink)' }}>{cov.waiting}</b> {cov.waiting === 1 ? 'person is' : 'people are'} queued but the machine is {STATUS_LABEL[seq.status].toLowerCase()} — nothing sends until you press {seq.status === 'paused' ? 'Resume' : 'Start'}.
              </div>
            )}
          </div>

          {cov.unreachableTotal > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.4, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2, color: 'var(--red)' }} /> Cannot be reached
              </div>
              {Object.entries(cov.unreachableCounts).filter(([, n]) => n > 0).map(([key, n]) => (
                <div key={key} style={{ marginBottom: 6 }}>
                  <button onClick={() => setOpenBucket(openBucket === key ? null : key)}
                    style={{ ...btn, width: '100%', justifyContent: 'space-between', padding: '8px 12px', fontWeight: 600, fontSize: 12.5 }}>
                    <span>{UNREACHABLE_LABELS[key] || key}</span>
                    <span style={{ color: 'var(--muted)' }}>{n} {openBucket === key ? '−' : '+'}</span>
                  </button>
                  {openBucket === key && (
                    <div style={{ padding: '9px 13px', fontSize: 12.3, color: 'var(--muted)', lineHeight: 1.85, borderLeft: '2px solid var(--line)', marginLeft: 6, marginTop: 5 }}>
                      {(cov.unreachable[key] || []).map((p) => <div key={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ''}</div>)}
                      {n > (cov.unreachable[key] || []).length && <div style={{ opacity: 0.7, marginTop: 4 }}>and {n - (cov.unreachable[key] || []).length} more</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── the messages ───────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...title, marginBottom: 4 }}>The messages</div>
        <p style={{ fontSize: 12.3, color: 'var(--muted)', margin: '0 0 14px' }}>
          Each gap is counted from the message before it. Changing a gap also re-times everyone already waiting.
        </p>
        {steps.map((s, i) => {
          const synced = templates.some((t) => t.name === s.template_name);
          return (
            <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'center', marginBottom: 9, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', width: 22 }}>{i + 1}.</span>
              <select value={s.template_name}
                onChange={(e) => saveSteps(steps.map((x, j) => j === i ? { ...x, template_name: e.target.value } : x))}
                style={{ ...sel, flex: 1, minWidth: 160, borderColor: synced ? 'var(--line)' : '#D97706' }}>
                {!synced && <option value={s.template_name}>{s.template_name} — not synced yet</option>}
                {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              <input type="number" min={0} value={Math.round(s.gap_hours)}
                onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, gap_hours: Number(e.target.value) } : x))}
                onBlur={() => saveSteps(steps)}
                style={num} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>hours after</span>
              <button onClick={() => saveSteps(steps.filter((_, j) => j !== i))} title="Remove this message"
                style={{ ...btn, padding: '7px 9px', color: 'var(--muted)' }}><X size={13} /></button>
            </div>
          );
        })}
        <button onClick={() => saveSteps([...steps, { template_name: templates[0]?.name || 'h1', template_language: 'en', gap_hours: 72 }])}
          style={{ ...btn, borderStyle: 'dashed', color: 'var(--muted)', marginTop: 4 }}><Plus size={14} /> Add a message</button>
      </div>

      {/* ── pacing + hours ─────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...title, marginBottom: 12 }}>Pacing</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <input type="number" min={1} max={1000} value={perDay}
            onChange={(e) => setPerDay(Number(e.target.value))}
            onBlur={() => saveRamp(Math.max(1, Math.min(1000, perDay)))}
            style={num} />
          <span style={{ fontSize: 12.7, color: 'var(--muted)' }}>new leads enter per day</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.7, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
            <input type="checkbox" checked={seq.hours_enabled} onChange={(e) => saveSeq({ hours_enabled: e.target.checked })} />
            Only send between
          </label>
          <input type="number" min={0} max={23} value={seq.send_start_hour} disabled={!seq.hours_enabled}
            onChange={(e) => setSeq({ ...seq, send_start_hour: Number(e.target.value) })}
            onBlur={(e) => saveSeq({ send_start_hour: Math.max(0, Math.min(23, Number(e.target.value))) })}
            style={{ ...num, opacity: seq.hours_enabled ? 1 : 0.45 }} />
          <span style={{ fontSize: 12.7, color: 'var(--muted)' }}>and</span>
          <input type="number" min={1} max={24} value={seq.send_end_hour} disabled={!seq.hours_enabled}
            onChange={(e) => setSeq({ ...seq, send_end_hour: Number(e.target.value) })}
            onBlur={(e) => saveSeq({ send_end_hour: Math.max(1, Math.min(24, Number(e.target.value))) })}
            style={{ ...num, opacity: seq.hours_enabled ? 1 : 0.45 }} />
          <span style={{ fontSize: 12.7, color: 'var(--muted)' }}>IST</span>
        </div>
      </div>

      {/* ── live feed ──────────────────────────────────────────────────── */}
      {activity.length > 0 && (
        <div style={card}>
          <div style={{ ...title, marginBottom: 12 }}>Recently sent</div>
          {activity.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
              {a.ok ? <CheckCircle2 size={13} style={{ color: 'var(--green)', flexShrink: 0 }} /> : <AlertTriangle size={13} style={{ color: 'var(--red)', flexShrink: 0 }} />}
              <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{a.lead_name}</span>
              <span style={{ color: 'var(--muted)' }}>{a.template_name}</span>
              {!a.ok && a.error && <span style={{ color: 'var(--red)', fontSize: 11.5 }}>{a.error}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.6 }}>
                {new Date(a.sent_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BannerLine({ b, style }: { b: Banner | null; style?: React.CSSProperties }) {
  if (!b) return null;
  const t = TONE[b.tone];
  return (
    <div role="status" aria-live="polite" style={{
      display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 13px', borderRadius: 11,
      background: t.bg, border: `1px solid ${t.border}`, color: t.fg, fontSize: 12.6, lineHeight: 1.55, ...(style || {}),
    }}>
      <t.Icon size={14} style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ color: b.tone === 'info' ? 'var(--muted)' : 'var(--ink)' }}>{b.text}</span>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ padding: '11px 13px', borderRadius: 11, background: 'var(--bg)', border: '1px solid var(--line)' }}>
      <div style={{ fontSize: 21, fontWeight: 800, color: tone || 'var(--ink)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11.6, color: 'var(--muted)', marginTop: 3 }}>{label}</div>
    </div>
  );
}
