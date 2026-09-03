'use client';

// =============================================================================
// CAMPAIGNS — the one-time blast.
// -----------------------------------------------------------------------------
// Pick who, pick the message, send now or schedule. Nothing here touches the
// C1–C8 follow-up: a lead can be mid-sequence and still get a campaign.
//
// The audience count is checked against the server before you commit, so the
// number on the button is the number of people who will actually receive it —
// duplicates collapsed and opt-outs already removed.
// =============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Send, Loader2, Clock, Pause, Play, X, Users, CheckCircle2, Megaphone } from 'lucide-react';
import type { RelayTemplate } from '@/lib/messages';

interface Campaign {
  id: string; name: string; template_name: string; audience: string;
  status: 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';
  scheduled_at: string | null;
  total: number; sent: number; failed: number; skipped: number;
  created_at: string;
}

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16,
  padding: 20, boxShadow: 'var(--shadow)',
};
const field: React.CSSProperties = {
  padding: '9px 11px', borderRadius: 9, border: '1px solid var(--line)',
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, outline: 'none', width: '100%',
};
const label: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase',
  letterSpacing: '.04em', display: 'block', marginBottom: 6,
};

export function CampaignPanel({ templates }: { templates: RelayTemplate[] }) {
  const [audience, setAudience] = useState<'cold' | 'hot' | 'both'>('cold');
  const [templateName, setTemplateName] = useState('');
  const [limit, setLimit] = useState(400);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [reach, setReach] = useState<{ count: number; suppressed: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [list, setList] = useState<Campaign[]>([]);

  const load = useCallback(async () => {
    try {
      const j = await fetch('/api/automation/campaign').then((r) => r.json());
      if (j.ok) setList(j.campaigns);
    } catch { /* the list simply stays as it is */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 10_000);   // live progress while one is sending
    return () => clearInterval(t);
  }, [load]);

  // Ask the server how many this would actually reach, whenever the shape changes.
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const j = await fetch('/api/automation/campaign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'preview', audience, limit }),
        }).then((r) => r.json());
        if (!cancelled && j.ok) setReach({ count: j.count, suppressed: j.suppressed });
      } catch { /* leave the previous number */ }
      if (!cancelled) setChecking(false);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [audience, limit]);

  const tpl = useMemo(() => templates.find((t) => t.name === templateName), [templates, templateName]);
  const ready = !!templateName && !!reach?.count && (when === 'now' || !!scheduledAt);

  async function create() {
    if (!ready || creating) return;
    const count = reach?.count ?? 0;
    const msg = when === 'now'
      ? `Send "${templateName}" to ${count} ${audience} lead${count === 1 ? '' : 's'} now?`
      : `Schedule "${templateName}" for ${count} ${audience} lead${count === 1 ? '' : 's'} at ${new Date(scheduledAt).toLocaleString()}?`;
    if (!confirm(`${msg}\n\nThis is a real WhatsApp send and cannot be undone once it starts.`)) return;

    setCreating(true); setNote(null);
    try {
      const j = await fetch('/api/automation/campaign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create', audience, limit, templateName,
          templateLanguage: tpl?.language || 'en',
          scheduledAt: when === 'later' ? scheduledAt : null,
        }),
      }).then((r) => r.json());
      if (j.ok) {
        setNote(j.scheduled
          ? `Scheduled for ${j.total} people.`
          : `Sending to ${j.total} people — first messages go out within 2 minutes.`);
        setTemplateName('');
        load();
      } else setNote(j.error);
    } catch { setNote('Could not reach the server.'); }
    setCreating(false);
  }

  async function act(id: string, action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel' && !confirm('Cancel this campaign?\n\nAnyone not yet messaged will not be messaged.')) return;
    await fetch('/api/automation/campaign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id }),
    });
    load();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── build one ──────────────────────────────────────────────────────── */}
      <section className="animate-pop-in" style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <Megaphone size={16} style={{ color: 'var(--green)' }} />
          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>New campaign</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 18 }}>
          A single message to many people, once. Separate from the follow-up sequence —
          nobody&rsquo;s drip is affected.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <div>
            <label style={label}>Who</label>
            <div style={{ display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: 3, width: '100%' }}>
              {(['cold', 'hot', 'both'] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAudience(a)}
                  style={{
                    flex: 1, padding: '7px 10px', borderRadius: 8, border: 'none', fontSize: 12.4,
                    fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                    background: audience === a ? 'var(--surface)' : 'transparent',
                    color: audience === a ? 'var(--ink)' : 'var(--muted)',
                    boxShadow: audience === a ? 'var(--shadow)' : 'none',
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={label}>How many (oldest first)</label>
            <input
              type="number" min={1} max={5000} style={field} value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
            />
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={label}>Message</label>
          <select style={field} value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
            <option value="">— choose an approved template —</option>
            {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          {tpl?.body && (
            <div style={{
              whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink)',
              background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10,
              padding: '11px 13px', marginTop: 9,
            }}>
              {tpl.body.replace(/\{\{\s*1\s*\}\}/g, 'Rahul').replace(/\{\{\s*\d+\s*\}\}/g, 'Migrizo')}
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 7 }}>shown with a sample name filled in</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={label}>When</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: 3 }}>
              {(['now', 'later'] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => setWhen(w)}
                  style={{
                    padding: '7px 15px', borderRadius: 8, border: 'none', fontSize: 12.4, fontWeight: 600, cursor: 'pointer',
                    background: when === w ? 'var(--surface)' : 'transparent',
                    color: when === w ? 'var(--ink)' : 'var(--muted)',
                    boxShadow: when === w ? 'var(--shadow)' : 'none',
                  }}
                >
                  {w === 'now' ? 'Send now' : 'Schedule'}
                </button>
              ))}
            </div>
            {when === 'later' && (
              <input
                type="datetime-local" style={{ ...field, width: 'auto', flex: 1, minWidth: 200 }}
                value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}
              />
            )}
          </div>
        </div>

        {/* the honest count, straight from the server */}
        <div style={{
          marginTop: 16, padding: '11px 13px', borderRadius: 10,
          background: 'var(--bg)', border: '1px solid var(--line)',
          fontSize: 12.6, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Users size={14} style={{ color: 'var(--green)', flex: 'none' }} />
          {checking ? (
            <span style={{ color: 'var(--muted)' }}>Counting…</span>
          ) : (
            <span>
              <b>{(reach?.count ?? 0).toLocaleString()}</b> {audience} lead{reach?.count === 1 ? '' : 's'} will receive this
              {!!reach?.suppressed && (
                <span style={{ color: 'var(--muted)' }}> · {reach.suppressed} skipped (opted out)</span>
              )}
            </span>
          )}
        </div>

        <button
          onClick={create}
          disabled={!ready || creating}
          style={{
            marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '11px 20px', borderRadius: 11, border: 'none',
            background: ready ? 'var(--green)' : 'var(--surface-3)',
            color: ready ? '#fff' : 'var(--muted)',
            fontSize: 13.5, fontWeight: 700, cursor: ready && !creating ? 'pointer' : 'not-allowed',
          }}
        >
          {creating ? <Loader2 size={15} className="animate-spin" /> : when === 'now' ? <Send size={15} /> : <Clock size={15} />}
          {when === 'now' ? `Send to ${(reach?.count ?? 0).toLocaleString()} people` : 'Schedule campaign'}
        </button>

        {note && (
          <div style={{ marginTop: 12, fontSize: 12.6, color: 'var(--ink)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
            {note}
          </div>
        )}
      </section>

      {/* ── what has been sent ─────────────────────────────────────────────── */}
      <section style={card}>
        <div style={{ fontSize: 13.8, fontWeight: 700, color: 'var(--ink)', marginBottom: 13 }}>Campaigns</div>
        {list.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing sent yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 11 }}>
            {list.map((c) => {
              const done = c.sent + c.failed + c.skipped;
              const pct = c.total > 0 ? Math.round((done / c.total) * 100) : 0;
              const TONE: Record<string, { bg: string; fg: string }> = {
                sending:   { bg: 'rgba(37,211,102,.14)', fg: 'var(--green)' },
                scheduled: { bg: 'var(--teal-bg)', fg: 'var(--teal-ink)' },
                paused:    { bg: 'var(--amber-bg)', fg: '#B45309' },
                done:      { bg: 'var(--surface-3)', fg: 'var(--muted)' },
                cancelled: { bg: 'var(--red-bg)', fg: 'var(--red)' },
              };
              const tone = TONE[c.status] || TONE.done;
              return (
                <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 13, background: 'var(--bg)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{c.template_name}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: tone.bg, color: tone.fg }}>
                      {c.status === 'sending' ? '● Sending' : c.status}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 'auto' }}>
                      {c.scheduled_at && c.status === 'scheduled'
                        ? `for ${new Date(c.scheduled_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                        : new Date(c.created_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '7px 0 8px' }}>
                    <b style={{ color: 'var(--green)' }}>{c.sent}</b> sent
                    {c.failed > 0 && <> · <b style={{ color: 'var(--red)' }}>{c.failed}</b> failed</>}
                    {c.skipped > 0 && <> · {c.skipped} skipped</>}
                    {' '}of {c.total} · {c.audience}
                  </div>

                  <div style={{ height: 6, borderRadius: 4, background: 'var(--surface)', border: '1px solid var(--line)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)', transition: 'width .5s' }} />
                  </div>

                  {(c.status === 'sending' || c.status === 'paused' || c.status === 'scheduled') && (
                    <div style={{ display: 'flex', gap: 7, marginTop: 11 }}>
                      {c.status === 'sending' && (
                        <button onClick={() => act(c.id, 'pause')} style={miniBtn}><Pause size={12} /> Pause</button>
                      )}
                      {(c.status === 'paused' || c.status === 'scheduled') && (
                        <button onClick={() => act(c.id, 'resume')} style={{ ...miniBtn, color: 'var(--green)', borderColor: 'var(--green)' }}>
                          <Play size={12} /> {c.status === 'scheduled' ? 'Send now' : 'Resume'}
                        </button>
                      )}
                      <button onClick={() => act(c.id, 'cancel')} style={{ ...miniBtn, color: 'var(--red)' }}><X size={12} /> Cancel</button>
                    </div>
                  )}
                  {c.status === 'done' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, fontSize: 11.5, color: 'var(--muted)' }}>
                      <CheckCircle2 size={12} style={{ color: 'var(--green)' }} /> Finished
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 8,
  border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)',
  fontSize: 11.8, fontWeight: 600, cursor: 'pointer',
};
