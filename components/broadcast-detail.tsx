'use client';

// =============================================================================
// ONE BROADCAST — watch it go, and see what happened to every person.
// -----------------------------------------------------------------------------
// While it is sending this page does two things on a timer: it reads the
// results (every 4 seconds), and it nudges the server to send the next few
// (every 10) so a short broadcast finishes while you watch. Close the page and
// it carries on anyway — the server's own 2-minute run keeps it moving.
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Ban, CheckCheck, Clock, Copy, Download, Loader2, MessageSquare, Moon, Pause, Play,
  RotateCcw, Search, Send, Trash2,
} from 'lucide-react';
import { RATE_LABEL, renderBody, resolveValues, countVars, type BroadcastDetail, type Rate, type RecipientLine } from '@/lib/broadcast/model';
import { describeSpec } from '@/lib/broadcast/audience';
import { Btn, Note, PhonePreview, StatusPill, api, fmtWhen, groupLabel, inputStyle, num } from './broadcast-ui';

type Filter = 'all' | 'waiting' | 'sent' | 'delivered' | 'read' | 'replied' | 'failed' | 'skipped';

const STATE_LOOK: Record<RecipientLine['state'], { label: string; bg: string; fg: string }> = {
  waiting: { label: 'Waiting', bg: 'var(--surface-3)', fg: 'var(--ink-2)' },
  sent: { label: 'Sent', bg: 'var(--teal-bg)', fg: 'var(--teal-ink)' },
  delivered: { label: 'Delivered', bg: 'var(--teal-bg)', fg: 'var(--teal-ink)' },
  read: { label: 'Read', bg: 'var(--green-bg)', fg: 'var(--green)' },
  failed: { label: 'Failed', bg: 'var(--red-bg)', fg: 'var(--red)' },
  skipped: { label: 'Skipped', bg: 'var(--amber-bg)', fg: 'var(--amber)' },
};

function matches(p: RecipientLine, f: Filter): boolean {
  switch (f) {
    case 'all': return true;
    case 'sent': return p.state === 'sent' || p.state === 'delivered' || p.state === 'read';
    case 'delivered': return p.state === 'delivered' || p.state === 'read';
    case 'replied': return p.replied;
    default: return p.state === f;
  }
}

export function BroadcastDetailView({
  id, isMobile, onBack, onOpenChat, onDuplicate, onDeleted,
}: {
  id: string;
  isMobile: boolean;
  onBack: () => void;
  onOpenChat: (leadId: string) => void;
  onDuplicate: (d: BroadcastDetail) => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState<BroadcastDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | 'cancel' | 'retry' | 'delete'>(null);
  const [showAll, setShowAll] = useState(false);
  const loading = useRef(false);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const j = await api<{ broadcast: BroadcastDetail }>(`/api/broadcast/detail?id=${encodeURIComponent(id)}`);
    loading.current = false;
    if (!j.ok) { setError(j.error || 'Could not load this broadcast.'); return; }
    setError(null); setD(j.broadcast);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // ---- keep it fresh, and keep it moving ---------------------------------------
  const status = d?.status;
  const holding = !!d?.holding;
  const finishedAt = d?.finishedAt;
  useEffect(() => {
    if (!status) return;
    const live = status === 'sending';
    // Delivered / read ticks keep arriving for a while after the last send.
    const recent = (status === 'done' || status === 'paused') && (!finishedAt || Date.now() - new Date(finishedAt).getTime() < 3_600_000);
    const every = live ? 4000 : status === 'scheduled' ? 20_000 : recent ? 20_000 : 0;
    if (!every) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, every);
    return () => clearInterval(t);
  }, [status, finishedAt, load]);

  useEffect(() => {
    if (status !== 'sending' || holding) return;
    const kick = () => { void api('/api/broadcast/run', { method: 'POST' }); };
    kick();
    const t = setInterval(kick, 10_000);
    return () => clearInterval(t);
  }, [status, holding]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setActing(action); setActionError(null);
    const j = await api<{ deleted?: boolean }>('/api/broadcast/detail', { method: 'POST', body: JSON.stringify({ id, action, ...extra }) });
    setActing(null); setAsk(null);
    if (!j.ok) { setActionError(j.error || 'That did not work.'); return; }
    if (j.deleted) { onDeleted(); return; }
    await load();
  }

  const people = d?.people;
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return (people || []).filter((p) => matches(p, filter)
      && (!q || p.name.toLowerCase().includes(q) || (digits.length >= 3 && p.phone.includes(digits))));
  }, [people, filter, search]);

  function exportCsv() {
    if (!d) return;
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [['Name', 'Phone', 'Result', 'Replied', 'Note', 'Sent at'].join(',')];
    for (const p of d.people) {
      rows.push([esc(p.name), esc(p.phone), STATE_LOOK[p.state].label, p.replied ? 'Yes' : 'No', esc(p.note || ''), p.sentAt ? esc(fmtWhen(p.sentAt)) : ''].join(','));
    }
    const url = URL.createObjectURL(new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${d.name.replace(/[^\w -]+/g, '').trim() || 'broadcast'}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  if (!d) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
        {error ? (
          <div style={{ display: 'grid', gap: 10, justifyItems: 'center', maxWidth: 360 }}>
            <Note tone="error">{error}</Note>
            <div style={{ display: 'flex', gap: 8 }}><Btn onClick={onBack}>Back</Btn><Btn onClick={() => void load()}>Try again</Btn></div>
          </div>
        ) : <Loader2 size={22} style={{ animation: 'spin .8s linear infinite', color: 'var(--muted)' }} />}
      </div>
    );
  }

  const c = d.counts;
  const went = c.sent;                       // everyone it reached Interakt for (sent + delivered + read)
  const processed = d.total - c.waiting;
  const pct = d.total ? Math.round((processed / d.total) * 100) : 0;
  const rateOf = (n: number) => (went ? ` · ${Math.round((n / went) * 100)}%` : '');
  const sample = d.people.find((p) => p.name) || d.people[0];
  const previewBody = renderBody(d.body, resolveValues(d.variables, countVars(d.body), { full_name: sample?.name || 'Asha Verma', visa_type: null }));
  const canDelete = d.status === 'draft' || (d.status === 'cancelled' && d.sent === 0 && d.failed === 0);

  const tiles: { key: Filter; label: string; value: number; sub?: string; Icon: typeof Send; tone?: string }[] = [
    { key: 'waiting', label: 'Waiting', value: c.waiting, Icon: Clock },
    { key: 'sent', label: 'Sent', value: went, Icon: Send },
    { key: 'delivered', label: 'Delivered', value: c.delivered, sub: rateOf(c.delivered), Icon: CheckCheck },
    { key: 'read', label: 'Read', value: c.read, sub: rateOf(c.read), Icon: CheckCheck, tone: 'var(--green)' },
    { key: 'replied', label: 'Replied', value: c.replied, sub: rateOf(c.replied), Icon: MessageSquare, tone: 'var(--green)' },
    { key: 'failed', label: 'Failed', value: c.failed, Icon: AlertTriangle, tone: c.failed ? 'var(--red)' : undefined },
    { key: 'skipped', label: 'Skipped', value: c.skipped, Icon: Ban, tone: c.skipped ? 'var(--amber)' : undefined },
  ];

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', minHeight: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isMobile ? '10px 12px' : '14px 22px', borderBottom: '1px solid var(--line)', background: 'var(--surface)', flex: 'none', flexWrap: 'wrap' }}>
        <button type="button" onClick={onBack} aria-label="Back to broadcasts" style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink-2)', display: 'grid', placeItems: 'center', cursor: 'pointer', flex: 'none' }}>
          <ArrowLeft size={17} />
        </button>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</h2>
            <StatusPill status={d.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {d.audienceLabel || describeSpec(d.spec, groupLabel)} · template {d.templateName}
            {d.createdByName ? ` · by ${d.createdByName}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {d.status === 'sending' && <Btn onClick={() => void act('pause')} busy={acting === 'pause'}><Pause size={14} /> Pause</Btn>}
          {d.status === 'paused' && <Btn kind="primary" onClick={() => void act('resume')} busy={acting === 'resume'}><Play size={14} /> Resume</Btn>}
          {d.status === 'scheduled' && <Btn kind="primary" onClick={() => void act('send_now')} busy={acting === 'send_now'}><Send size={14} /> Send now</Btn>}
          {d.status === 'scheduled' && <Btn onClick={() => void act('pause')} busy={acting === 'pause'}><Pause size={14} /> Hold</Btn>}
          {(d.status === 'sending' || d.status === 'paused' || d.status === 'scheduled') && <Btn kind="danger" onClick={() => setAsk('cancel')}><Ban size={14} /> Cancel</Btn>}
          {c.failed > 0 && d.status !== 'draft' && d.status !== 'scheduled' && <Btn onClick={() => setAsk('retry')}><RotateCcw size={14} /> Retry {num(c.failed)} failed</Btn>}
          <Btn onClick={() => onDuplicate(d)} title="Start a new broadcast with the same people and message"><Copy size={14} /> Duplicate</Btn>
          {canDelete && <Btn kind="danger" onClick={() => setAsk('delete')} title="Delete this broadcast"><Trash2 size={14} /> Delete</Btn>}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? 12 : 22 }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 14 }}>
          {actionError && <Note tone="error">{actionError}</Note>}
          {d.status === 'paused' && d.pausedReason && <Note tone="warn"><b>It paused itself.</b> {d.pausedReason}</Note>}
          {d.status === 'paused' && !d.pausedReason && <Note tone="info">Paused. {num(c.waiting)} {c.waiting === 1 ? 'person is' : 'people are'} still waiting — press Resume to carry on{!d.startedAt && d.scheduledAt && new Date(d.scheduledAt).getTime() > Date.now() ? ` (it goes back to waiting for ${fmtWhen(d.scheduledAt)})` : ''}.</Note>}
          {d.status === 'scheduled' && <Note tone="info"><Clock size={13} style={{ display: 'inline-block', verticalAlign: -2, marginRight: 5 }} />Scheduled for <b>{fmtWhen(d.scheduledAt)}</b> — it starts on its own, with this page closed too.</Note>}
          {d.holding && <Note tone="info"><Moon size={13} style={{ display: 'inline-block', verticalAlign: -2, marginRight: 5 }} />Quiet hours — nothing goes out between 9 pm and 9 am India time. It carries on at <b>{fmtWhen(d.resumesAt)}</b>. Switch quiet hours off below to send now.</Note>}

          {/* progress */}
          {d.status !== 'draft' && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-.02em' }}>{num(processed)}</span>
                <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>of {num(d.total)} done · {pct}%</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
                  {d.startedAt ? `Started ${fmtWhen(d.startedAt)}` : ''}{d.finishedAt ? ` · finished ${fmtWhen(d.finishedAt)}` : ''}
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 99, background: 'var(--surface-3)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--teal)', borderRadius: 99, transition: 'width .5s ease' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 3 : 7}, minmax(0,1fr))`, gap: 8, marginTop: 14 }}>
                {tiles.map(({ key, label, value, sub, Icon, tone }) => {
                  const on = filter === key;
                  return (
                    <button
                      key={key} type="button" onClick={() => setFilter(on ? 'all' : key)} aria-pressed={on}
                      style={{ textAlign: 'left', padding: '10px 11px', borderRadius: 11, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid ' + (on ? 'var(--teal)' : 'var(--line)'), background: on ? 'var(--teal-bg)' : 'var(--surface-2)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}><Icon size={12} /> {label}</div>
                      <div style={{ fontSize: 19, fontWeight: 800, color: tone && value ? tone : 'var(--ink)', marginTop: 3, letterSpacing: '-.01em' }}>
                        {num(value)}<span style={{ fontSize: 11, fontWeight: 650, color: 'var(--muted)' }}>{value ? sub : ''}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {(d.status === 'sending' || d.status === 'paused' || d.status === 'scheduled') && (
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-2)' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--ink-2)' }}>Speed</span>
                  <select value={d.rate} disabled={acting === 'settings'} onChange={(e) => void act('settings', { rate: e.target.value as Rate })} style={{ ...inputStyle, height: 34, width: 240 }}>
                    {(['fast', 'normal', 'gentle'] as Rate[]).map((r) => <option key={r} value={r}>{RATE_LABEL[r]}</option>)}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--ink-2)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={d.quietHours} disabled={acting === 'settings'} onChange={(e) => void act('settings', { quietHours: e.target.checked })} style={{ accentColor: 'var(--teal)', width: 15, height: 15 }} />
                    Quiet hours (9 pm – 9 am India time)
                  </label>
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'minmax(0,1fr) 340px', alignItems: 'start' }}>
            {/* people */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, borderBottom: '1px solid var(--line-2)', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
                  <Search size={14} style={{ position: 'absolute', left: 11, top: 12, color: 'var(--muted)' }} />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find someone by name or number" style={{ ...inputStyle, width: '100%', paddingLeft: 32 }} />
                </div>
                {filter !== 'all' && <Btn small onClick={() => setFilter('all')}>Showing: {filter} ✕</Btn>}
                <Btn small onClick={exportCsv} disabled={!d.people.length} title="Download everyone and their result as a spreadsheet"><Download size={13} /> Export</Btn>
              </div>
              {!d.people.length && (
                <div style={{ padding: 22, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
                  {d.status === 'draft' ? 'This is a draft — the list of people is built when you launch it.' : 'Nobody on this broadcast.'}
                </div>
              )}
              {(showAll ? shown : shown.slice(0, 200)).map((p) => {
                const look = STATE_LOOK[p.state];
                return (
                  <div
                    key={p.id}
                    onClick={p.leadId ? () => onOpenChat(p.leadId!) : undefined}
                    title={p.leadId ? 'Open this chat' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--line-2)', cursor: p.leadId ? 'pointer' : 'default', fontSize: 12.5 }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 650, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.phone}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name ? p.phone : ''}{p.note ? `${p.name ? ' · ' : ''}${p.note}` : ''}
                      </div>
                    </div>
                    {p.replied && <span style={{ fontSize: 10.5, fontWeight: 750, padding: '2px 8px', borderRadius: 99, background: 'var(--green-bg)', color: 'var(--green)', flex: 'none' }}>Replied</span>}
                    <span style={{ fontSize: 10.5, fontWeight: 750, padding: '2px 8px', borderRadius: 99, background: look.bg, color: look.fg, flex: 'none' }}>{look.label}</span>
                    {!isMobile && <span style={{ width: 108, textAlign: 'right', color: 'var(--muted)', fontSize: 11.5, flex: 'none' }}>{p.sentAt ? fmtWhen(p.sentAt) : ''}</span>}
                  </div>
                );
              })}
              {d.people.length > 0 && !shown.length && <div style={{ padding: 18, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Nobody matches.</div>}
              {!showAll && shown.length > 200 && (
                <div style={{ padding: 12, textAlign: 'center' }}><Btn small onClick={() => setShowAll(true)}>Show all {num(shown.length)}</Btn></div>
              )}
            </div>

            {/* the message */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 14, boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ fontSize: 12, fontWeight: 750, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 9 }}>{went > 0 ? 'What was sent' : 'The message'}</div>
              <PhonePreview body={previewBody} header={d.header} empty="No message chosen yet." />
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 9, lineHeight: 1.5 }}>
                Shown as {sample?.name?.split(/\s+/)[0] || 'one person'} {went > 0 ? 'received' : 'will receive'} it. Delivered and Read come from WhatsApp and can keep arriving for hours.
              </div>
            </div>
          </div>
        </div>
      </div>

      {ask && (
        <div onClick={() => !acting && setAsk(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16, animation: 'fadeIn .15s ease' }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ width: '100%', maxWidth: 420, background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--line)', padding: 20, boxShadow: '0 24px 60px rgba(0,0,0,.3)', animation: 'popIn .18s ease' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 800, color: 'var(--ink)' }}>
              {ask === 'cancel' ? 'Cancel this broadcast?' : ask === 'retry' ? `Send again to the ${num(c.failed)} it failed for?` : 'Delete this broadcast?'}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {ask === 'cancel' && `${num(c.waiting)} ${c.waiting === 1 ? 'person has' : 'people have'} not been sent it yet and will not be. The ${num(went)} already sent stay sent. This cannot be undone — to carry on later, use Pause instead.`}
              {ask === 'retry' && 'Only the people it failed for are tried again — nobody who received it gets it twice. Anyone WhatsApp is still limiting is skipped.'}
              {ask === 'delete' && 'It was never sent to anyone, so nothing is lost.'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setAsk(null)} disabled={!!acting}>Keep it</Btn>
              <Btn kind={ask === 'retry' ? 'primary' : 'danger'} busy={!!acting}
                onClick={() => void act(ask === 'cancel' ? 'cancel' : ask === 'retry' ? 'retry_failed' : 'delete')}>
                {ask === 'cancel' ? 'Yes, cancel it' : ask === 'retry' ? 'Yes, retry them' : 'Yes, delete'}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
