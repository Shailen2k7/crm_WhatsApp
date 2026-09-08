'use client';

// =============================================================================
// HOT LEADS — its own machine, with the whole life cycle on one screen.
// -----------------------------------------------------------------------------
// WHY THIS IS SEPARATE FROM THE C1–C8 PAGE
//
// Hot leads were being missed, and the reason was not a bug. Both existing
// machines said audience 'both' and both looked perfectly healthy. But C1–C8
// enrols oldest lead first, and hot leads are the newest, so 47 of them sat at
// queue position 1000+ while the machine was at 292. Meanwhile the no-reply
// chase can only take people who never replied, and a hot lead replied. They
// fell in the gap between two healthy-looking machines, and no screen in the
// product could have told you.
//
// So this page is built around the one question that would have caught it:
//
//     HAVE WE MESSAGED EVERY SINGLE HOT LEAD, AND IF NOT, WHO AND WHY?
//
// The coverage card refuses to say "pending". Pending is a subtraction, and a
// subtraction hides people the engine can never reach behind people it simply
// has not reached yet. Every lead lands in exactly one bucket, and everyone the
// machine cannot message is named, because each of those needs a human
// decision rather than a number on a dashboard.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  Play, Pause, Square, Trash2, Zap, Send, Loader2, AlertTriangle,
  CheckCircle2, Clock, Users, X, Plus,
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

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16,
  padding: 20, boxShadow: 'var(--shadow)', marginBottom: 14,
};
const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px',
  borderRadius: 10, border: '1px solid var(--line)', background: 'transparent',
  color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const sel: React.CSSProperties = {
  padding: '8px 11px', borderRadius: 9, border: '1px solid var(--line)',
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, outline: 'none', maxWidth: '100%',
};
const num: React.CSSProperties = { ...sel, width: 66, textAlign: 'center' };
const title: React.CSSProperties = { fontSize: 13.8, fontWeight: 700, color: 'var(--ink)' };

const UNREACHABLE_LABELS: Record<string, string> = {
  noPhone: 'No phone number on the lead',
  badPhone: 'Phone number cannot be dialled',
  optedOut: 'Opted out of messages',
  busyElsewhere: 'Mid-way through another machine',
  industryFiltered: 'Excluded by the industry filter',
};

export function HotLeadsPanel({ templates }: { templates: RelayTemplate[] }) {
  const [seq, setSeq] = useState<Seq | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [perDay, setPerDay] = useState(25);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openBucket, setOpenBucket] = useState<string | null>(null);

  // ── load ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setErr(null);
    try {
      // Identify the hot machine from the cheap list, NOT by fetching each
      // sequence in turn. The full endpoint computes a dozen exact counts and
      // two RPCs per call; asking it N times just to read one field is what
      // made this page take twenty seconds to appear.
      const lr = await fetch('/api/automation/sequence?list=1', { cache: 'no-store' });
      const lj = await lr.json();
      if (!lj.ok) { setSeq(null); setLoading(false); return; }

      const list: { id: string; audience: string; trigger_mode: string }[] = lj.sequences || [];
      const mine = list.find((s) => s.audience === 'hot' && (s.trigger_mode || 'backlog') === 'backlog');
      if (!mine) { setSeq(null); setCov(null); setLoading(false); return; }

      // Stats and coverage in parallel: neither depends on the other.
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
      setErr('Could not load. Check the connection and try again.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!seq || seq.status !== 'running') return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [seq, load]);

  // ── actions ─────────────────────────────────────────────────────────────
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setActing(action); setNote(null); setErr(null);
    try {
      const r = await fetch('/api/automation/sequence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: seq?.id, ...extra }),
      });
      const j = await r.json();
      if (!j.ok) setErr(j.error || 'That did not work.');
      else if (action === 'enrol_all') setNote(`${j.enrolled} lead${j.enrolled === 1 ? '' : 's'} added to the queue.`);
      else if (action === 'release_now') setNote(`${j.released} message${j.released === 1 ? '' : 's'} released to go now.`);
      else if (action === 'delete') { setNote('Deleted.'); setSeq(null); setCov(null); }
      if (j.ok) await load();
    } catch { setErr('That did not work. Try again.'); }
    setActing(null); setConfirmDelete(false);
  };

  const save = async (patch: Record<string, unknown>) => {
    if (!seq) return;
    await fetch('/api/automation/sequence', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: seq.id, ...patch }),
    });
    await load();
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      <Loader2 className="spin" size={18} style={{ verticalAlign: 'middle' }} /> Loading…
    </div>;
  }

  // ── nothing yet ─────────────────────────────────────────────────────────
  if (!seq) {
    return (
      <div style={card}>
        <div style={{ ...title, fontSize: 16, marginBottom: 6 }}>No hot lead machine yet</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.65, margin: '0 0 8px' }}>
          Hot leads are people who already spoke to you. They should not get the
          C1–C8 copy, which is written for someone who went quiet. This creates a
          separate machine with its own four messages and its own pacing.
        </p>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.65, margin: '0 0 16px' }}>
          It is created switched <b style={{ color: 'var(--ink)' }}>off</b>. Nothing sends until you
          press Start, so it is safe to set up while templates are still waiting on Meta approval.
        </p>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        <button
          onClick={() => act('create', { name: 'Hot leads follow-up', audience: 'hot', per_day: 25 })}
          disabled={acting === 'create'}
          style={{ ...btn, background: 'var(--green)', color: '#fff', borderColor: 'transparent' }}
        >
          {acting === 'create' ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
          Create the hot machine
        </button>
      </div>
    );
  }

  const running = seq.status === 'running';
  const pct = cov && cov.total > 0 ? Math.round((cov.messaged / cov.total) * 100) : 0;
  const day = seq.started_at
    ? Math.floor((Date.now() - new Date(seq.started_at).getTime()) / 86_400_000) + 1 : 0;

  const statusColor = running ? 'var(--green)'
    : seq.status === 'paused' ? '#D97706'
    : seq.status === 'stopped' ? 'var(--red)' : 'var(--muted)';

  return (
    <div>
      {/* ── header + life cycle ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ ...title, fontSize: 17 }}>{seq.name}</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
            borderRadius: 999, background: 'color-mix(in srgb, var(--surface) 70%, transparent)',
            border: `1px solid ${statusColor}`, color: statusColor, fontSize: 12, fontWeight: 700,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: statusColor }} />
            {seq.status === 'draft' ? 'Not started' : seq.status[0].toUpperCase() + seq.status.slice(1)}
            {running && day > 0 && ` · day ${day}`}
          </span>
        </div>
        <p style={{ fontSize: 12.8, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 15px' }}>
          Sends {steps.length} message{steps.length === 1 ? '' : 's'} to hot leads, {perDay}/day.
          Anyone who replies leaves immediately.
        </p>

        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {!running ? (
            <button onClick={() => act(seq.status === 'draft' ? 'start' : 'resume')} disabled={!!acting}
              style={{ ...btn, background: 'var(--green)', color: '#fff', borderColor: 'transparent' }}>
              <Play size={15} /> {seq.status === 'draft' ? 'Start' : 'Resume'}
            </button>
          ) : (
            <button onClick={() => act('pause')} disabled={!!acting} style={btn}>
              <Pause size={15} /> Pause
            </button>
          )}

          <button onClick={() => act('stop')} disabled={!!acting || seq.status === 'stopped'}
            style={{ ...btn, color: 'var(--red)' }}>
            <Square size={14} /> Stop
          </button>

          {/* The control this whole page exists for. */}
          <button onClick={() => act('enrol_all')} disabled={!!acting}
            style={{ ...btn, borderColor: 'var(--green)', color: 'var(--green)' }}>
            {acting === 'enrol_all' ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}
            Queue everyone now
          </button>

          <button onClick={() => act('release_now')} disabled={!!acting} style={btn}>
            <Send size={14} /> Send waiting now
          </button>

          <div style={{ flex: 1 }} />

          {confirmDelete ? (
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <span style={{ fontSize: 12.3, color: 'var(--muted)' }}>Delete it and its history?</span>
              <button onClick={() => act('delete')} disabled={!!acting}
                style={{ ...btn, background: 'var(--red)', color: '#fff', borderColor: 'transparent' }}>
                {acting === 'delete' ? <Loader2 size={14} className="spin" /> : 'Yes, delete'}
              </button>
              <button onClick={() => setConfirmDelete(false)} style={{ ...btn, padding: '9px 11px' }}>
                <X size={14} />
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} disabled={!!acting}
              style={{ ...btn, color: 'var(--muted)' }}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>

        {note && <div style={{ marginTop: 12, fontSize: 12.6, color: 'var(--green)' }}>{note}</div>}
        {err && <div style={{ marginTop: 12, fontSize: 12.6, color: 'var(--red)' }}>{err}</div>}
      </div>

      {/* ── coverage: the point of the page ─────────────────────────────── */}
      {cov && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
            <Users size={15} style={{ color: 'var(--muted)' }} />
            <span style={title}>Coverage</span>
            <span style={{ marginLeft: 'auto', fontSize: 12.4, color: 'var(--muted)' }}>
              {cov.messaged} of {cov.total} messaged
            </span>
          </div>

          <div style={{
            height: 9, borderRadius: 99, background: 'var(--bg)', overflow: 'hidden',
            margin: '12px 0 14px', border: '1px solid var(--line)',
          }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)', transition: 'width .4s' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
            <Tile label="Messaged" value={cov.messaged} tone="var(--green)" />
            <Tile label="Queued, not sent" value={cov.waiting} />
            <Tile label="Left the sequence" value={cov.exitedTotal} />
            <Tile label="Still to go" value={cov.stillToGo} tone={cov.stillToGo > 0 ? '#D97706' : undefined} />
            <Tile label="Cannot be reached" value={cov.unreachableTotal} tone={cov.unreachableTotal > 0 ? 'var(--red)' : undefined} />
          </div>

          {/* The honest bottom line. */}
          <div style={{
            marginTop: 14, padding: '11px 13px', borderRadius: 11,
            background: 'var(--bg)', border: '1px solid var(--line)',
            fontSize: 12.7, color: 'var(--muted)', lineHeight: 1.6,
          }}>
            {cov.stillToGo === 0 && cov.unreachableTotal === 0 ? (
              <><CheckCircle2 size={13} style={{ verticalAlign: -2, color: 'var(--green)' }} />{' '}
              Every hot lead is accounted for. Nobody is waiting and nobody is unreachable.</>
            ) : cov.stillToGo === 0 ? (
              <><CheckCircle2 size={13} style={{ verticalAlign: -2, color: 'var(--green)' }} />{' '}
              Everyone the machine can reach is in it. The {cov.unreachableTotal} below need a
              person to fix something before they can be messaged.</>
            ) : (
              <><Clock size={13} style={{ verticalAlign: -2, color: '#D97706' }} />{' '}
              <b style={{ color: 'var(--ink)' }}>{cov.stillToGo}</b> reachable lead{cov.stillToGo === 1 ? ' is' : 's are'} not
              in the queue yet. At {perDay}/day that is {Math.ceil(cov.stillToGo / Math.max(1, perDay))} more
              day{Math.ceil(cov.stillToGo / Math.max(1, perDay)) === 1 ? '' : 's'}, or press
              &ldquo;Queue everyone now&rdquo; to add them all at once.</>
            )}
          </div>

          {/* Named, because a count cannot be acted on. */}
          {cov.unreachableTotal > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.4, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2, color: 'var(--red)' }} /> Cannot be reached
              </div>
              {Object.entries(cov.unreachableCounts)
                .filter(([, n]) => n > 0)
                .map(([key, n]) => (
                  <div key={key} style={{ marginBottom: 6 }}>
                    <button
                      onClick={() => setOpenBucket(openBucket === key ? null : key)}
                      style={{
                        ...btn, width: '100%', justifyContent: 'space-between',
                        padding: '8px 12px', fontWeight: 600, fontSize: 12.5,
                      }}
                    >
                      <span>{UNREACHABLE_LABELS[key] || key}</span>
                      <span style={{ color: 'var(--muted)' }}>{n} {openBucket === key ? '−' : '+'}</span>
                    </button>
                    {openBucket === key && (
                      <div style={{
                        padding: '9px 13px', fontSize: 12.3, color: 'var(--muted)',
                        lineHeight: 1.85, borderLeft: '2px solid var(--line)', marginLeft: 6, marginTop: 5,
                      }}>
                        {(cov.unreachable[key] || []).map((p) => (
                          <div key={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ''}</div>
                        ))}
                        {n > (cov.unreachable[key] || []).length && (
                          <div style={{ opacity: 0.7, marginTop: 4 }}>
                            and {n - (cov.unreachable[key] || []).length} more
                          </div>
                        )}
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
          Each gap is counted from the message before it. Changing a gap also re-times
          everyone already waiting.
        </p>
        {steps.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'center', marginBottom: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', width: 22 }}>{i + 1}.</span>
            <select
              value={s.template_name}
              onChange={(e) => {
                const next = steps.map((x, j) => j === i ? { ...x, template_name: e.target.value } : x);
                setSteps(next); save({ steps: next });
              }}
              style={{ ...sel, flex: 1, minWidth: 160 }}
            >
              {!templates.some((t) => t.name === s.template_name) && (
                <option value={s.template_name}>{s.template_name} (not synced yet)</option>
              )}
              {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <input
              type="number" min={0} value={Math.round(s.gap_hours)}
              onChange={(e) => {
                const next = steps.map((x, j) => j === i ? { ...x, gap_hours: Number(e.target.value) } : x);
                setSteps(next);
              }}
              onBlur={() => save({ steps })}
              style={num}
            />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>hours after</span>
            <button
              onClick={() => { const next = steps.filter((_, j) => j !== i); setSteps(next); save({ steps: next }); }}
              style={{ ...btn, padding: '7px 9px', color: 'var(--muted)' }}
            ><X size={13} /></button>
          </div>
        ))}
        <button
          onClick={() => {
            const next = [...steps, { template_name: templates[0]?.name || 'h1', template_language: 'en', gap_hours: 72 }];
            setSteps(next); save({ steps: next });
          }}
          style={{ ...btn, borderStyle: 'dashed', color: 'var(--muted)', marginTop: 4 }}
        ><Plus size={14} /> Add a message</button>
      </div>

      {/* ── pacing + hours ─────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...title, marginBottom: 12 }}>Pacing</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <input type="number" min={1} max={1000} value={perDay}
            onChange={(e) => setPerDay(Number(e.target.value))}
            onBlur={() => save({ ramp: [{ per_day: perDay, duration_days: null }] })}
            style={num} />
          <span style={{ fontSize: 12.7, color: 'var(--muted)' }}>new leads enter per day</span>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.7, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="checkbox" checked={seq.hours_enabled}
              onChange={(e) => save({ hours_enabled: e.target.checked })} />
            Only send between
          </label>
          <input type="number" min={0} max={23} value={seq.send_start_hour}
            onChange={(e) => save({ send_start_hour: Number(e.target.value) })} style={num} />
          <span style={{ fontSize: 12.7, color: 'var(--muted)' }}>and</span>
          <input type="number" min={1} max={24} value={seq.send_end_hour}
            onChange={(e) => save({ send_end_hour: Number(e.target.value) })} style={num} />
          <span style={{ fontSize: 12.7, color: 'var(--muted)' }}>IST</span>
        </div>
      </div>

      {/* ── live feed ──────────────────────────────────────────────────── */}
      {activity.length > 0 && (
        <div style={card}>
          <div style={{ ...title, marginBottom: 12 }}>Recently sent</div>
          {activity.map((a) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
              borderBottom: '1px solid var(--line)', fontSize: 12.5,
            }}>
              {a.ok
                ? <CheckCircle2 size={13} style={{ color: 'var(--green)', flexShrink: 0 }} />
                : <AlertTriangle size={13} style={{ color: 'var(--red)', flexShrink: 0 }} />}
              <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{a.lead_name}</span>
              <span style={{ color: 'var(--muted)' }}>{a.template_name}</span>
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

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ padding: '11px 13px', borderRadius: 11, background: 'var(--bg)', border: '1px solid var(--line)' }}>
      <div style={{ fontSize: 21, fontWeight: 800, color: tone || 'var(--ink)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11.6, color: 'var(--muted)', marginTop: 3 }}>{label}</div>
    </div>
  );
}
