'use client';

// =============================================================================
// THE ASSISTANT PAGE — the switch, who needs a human, and what it has done.
// Also exports the small pill that sits in each chat's header.
// =============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Bot, Hand, MessageSquare, RefreshCw } from 'lucide-react';
import { api, Btn, Note, SectionCard, fmtWhen, num } from './broadcast-ui';

interface Hold { conversationId: string; openKey: string; at: string; reason: string; name: string; phone: string }
interface Activity { at: string; conversationId: string; openKey: string; name: string; kind: string; note: string }
interface Overview {
  isAdmin: boolean;
  config: { enabled: boolean; activatedAt: string | null; bookingSlug: string; followUps: boolean };
  keyConfigured: boolean;
  problem: { at: string; text: string } | null;
  today: { replied: number; verdicts: number; booked: number; handedOver: number; followUps: number };
  holds: Hold[];
  activity: Activity[];
  followUpsWaiting: number;
}

const KIND_TONE: Record<string, [string, string]> = {
  replied: ['var(--teal-bg)', 'var(--teal-ink)'],
  verdict: ['var(--green-bg)', 'var(--green)'],
  booked: ['var(--green-bg)', 'var(--green)'],
  rescheduled: ['var(--green-bg)', 'var(--green)'],
  'handed over': ['var(--amber-bg)', 'var(--amber)'],
  'follow-up': ['var(--teal-bg)', 'var(--teal-ink)'],
};

function Toggle({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={`${label} ${on ? 'on' : 'off'}`} disabled={disabled} onClick={onClick}
      style={{ width: 46, height: 26, borderRadius: 99, border: 0, padding: 3, flex: 'none', cursor: disabled ? 'default' : 'pointer', background: on ? 'var(--teal)' : 'var(--line)', opacity: disabled ? 0.55 : 1, transition: 'background .15s' }}
    >
      <span style={{ display: 'block', width: 20, height: 20, borderRadius: 99, background: '#fff', transform: on ? 'translateX(20px)' : 'none', transition: 'transform .15s', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
    </button>
  );
}

function Tile({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 13px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 650 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 750, color: warn && value > 0 ? 'var(--amber)' : 'var(--ink)', marginTop: 2 }}>{num(value)}</div>
    </div>
  );
}

export function AiPanel({ isMobile, onOpenChat }: { isMobile: boolean; onOpenChat: (key: string) => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Overview>('/api/ai/overview');
    if (r.ok) { setOv(r); setError(null); } else setError(r.error || 'Could not load the assistant.');
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const post = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    const r = await api('/api/ai/overview', { method: 'POST', body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) setError(r.error || 'That did not save.'); else setError(null);
    await load();
  };

  if (!ov) {
    return (
      <div style={{ flex: 1, padding: 22, color: 'var(--muted)', fontSize: 13 }}>
        {error ? <Note tone="error">{error}</Note> : 'Loading the assistant…'}
      </div>
    );
  }
  const on = ov.config.enabled;

  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: isMobile ? '14px 12px 90px' : '22px 22px 40px', display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: on ? 'var(--teal)' : 'var(--surface-3)', color: on ? '#fff' : 'var(--muted)', display: 'grid', placeItems: 'center', flex: 'none' }}><Bot size={21} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 780, color: 'var(--ink)' }}>Assistant</h2>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              {on ? `On since ${fmtWhen(ov.config.activatedAt)}. It answers chats, gives verdicts and books calls.` : 'Off. Your team answers every chat.'}
            </div>
          </div>
          <Toggle on={on} disabled={!ov.isAdmin || busy === 'switch'} label="Assistant" onClick={() => (on ? post('switch', { action: 'switch', enabled: false }) : setConfirmOn(true))} />
        </div>

        {error && <Note tone="error">{error}</Note>}
        {!ov.keyConfigured && <Note tone="warn">The Anthropic key is not set on this site, so the assistant cannot think. Add ANTHROPIC_API_KEY in Netlify and redeploy.</Note>}
        {ov.problem && <Note tone="error">The assistant has stopped: {ov.problem.text} (since {fmtWhen(ov.problem.at)})</Note>}
        {!ov.isAdmin && <Note tone="info">Only an admin can switch the assistant on or off. You can still give a chat back to it or switch it off for one chat.</Note>}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: `repeat(${isMobile ? 2 : 5}, minmax(0,1fr))` }}>
          <Tile label="Needs you" value={ov.holds.length} warn />
          <Tile label="Replies today" value={ov.today.replied} />
          <Tile label="Verdicts today" value={ov.today.verdicts} />
          <Tile label="Calls booked today" value={ov.today.booked} />
          <Tile label="Follow-ups today" value={ov.today.followUps} />
        </div>

        <SectionCard
          title={`Needs you${ov.holds.length ? ` · ${ov.holds.length}` : ''}`}
          hint="The assistant was not sure, so it stopped replying in these chats. Reply to the customer, then give the chat back. If you do nothing, it comes back by itself 12 hours after your last reply."
        >
          {ov.holds.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '4px 0' }}>Nothing is waiting for you.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {ov.holds.map((h) => (
                <div key={h.conversationId} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', display: 'grid', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <Hand size={15} style={{ color: 'var(--amber)', flex: 'none' }} />
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 'auto', flex: 'none' }}>{fmtWhen(h.at)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>{h.reason}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Btn small kind="primary" onClick={() => onOpenChat(h.openKey)}><MessageSquare size={13} /> Open chat</Btn>
                    <Btn small busy={busy === h.conversationId} onClick={() => post(h.conversationId, { action: 'resume', conversationId: h.conversationId })}>Give back to the assistant</Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="What it did" right={<Btn small kind="ghost" onClick={load} title="Refresh"><RefreshCw size={13} /></Btn>}>
          {ov.activity.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '4px 0' }}>{on ? 'Nothing yet. It acts within a minute or two of a customer writing.' : 'Nothing yet.'}</div>
          ) : (
            <div style={{ display: 'grid' }}>
              {ov.activity.map((a, i) => {
                const tone = KIND_TONE[a.kind] || ['var(--surface-3)', 'var(--ink-2)'];
                return (
                  <button
                    key={a.at + a.conversationId + i} type="button" onClick={() => onOpenChat(a.openKey)}
                    style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 3, textAlign: 'left', background: 'transparent', border: 0, borderTop: i ? '1px solid var(--line)' : 0, padding: '9px 2px', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 750, padding: '2px 7px', borderRadius: 99, background: tone[0], color: tone[1], flex: 'none', textTransform: 'capitalize' }}>{a.kind}</span>
                      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 'auto', flex: 'none' }}>{fmtWhen(a.at)}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.45 }}>{a.note}</div>
                  </button>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title="How it works">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--ink)' }}>Call-booking follow-ups</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2 }}>
                Eligible people who have not booked get cbr1 after 2 quiet days, then cbr2 and cbr3 a day apart, 10am–7pm IST. {ov.followUpsWaiting ? `${num(ov.followUpsWaiting)} waiting.` : ''}
              </div>
            </div>
            <Toggle on={ov.config.followUps} disabled={!ov.isAdmin || busy === 'followups'} label="Call-booking follow-ups" onClick={() => post('followups', { action: 'followups', enabled: !ov.config.followUps })} />
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.7 }}>
            <li>It replies about a minute after the customer&apos;s last message, at any hour.</li>
            <li>With a CV in the chat it gives the verdict using your saved replies and brochures, and stars the strongest profiles.</li>
            <li>It books and moves calls on the CRM booking page ({ov.config.bookingSlug}), so they are normal CRM meetings.</li>
            <li>It stays out of a chat for 10 minutes after any message a teammate sends there.</li>
            <li>It never writes to Won clients or anyone who said STOP, and it leaves a new lead&apos;s first message to T1.</li>
            <li>When it is not sure, it sends nothing, leaves a note in the chat and notifies the team.</li>
          </ul>
        </SectionCard>
      </div>

      {confirmOn && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'grid', placeItems: 'center', zIndex: 80, padding: 16 }} onClick={() => setConfirmOn(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 16, padding: 20, maxWidth: 420, width: '100%', boxShadow: 'var(--shadow-lg, 0 20px 50px rgba(0,0,0,.25))' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 760, color: 'var(--ink)' }}>Switch the assistant on?</h3>
            <p style={{ margin: '9px 0 16px', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
              From now it replies to customers by itself, gives eligibility verdicts and books calls. It answers only messages that arrive after you switch it on. You can switch it off here at any time.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="ghost" onClick={() => setConfirmOn(false)}>Cancel</Btn>
              <Btn kind="primary" busy={busy === 'switch'} onClick={async () => { await post('switch', { action: 'switch', enabled: true }); setConfirmOn(false); }}>Switch on</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The assistant's status in one chat, in that chat's header. */
export function AiChatPill({ conversationId, compact }: { conversationId: string | null; compact?: boolean }) {
  const [st, setSt] = useState<{ enabled: boolean; status: 'active' | 'hold' | 'off'; holdReason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) { setSt(null); return; }
    const r = await api<{ enabled: boolean; status: 'active' | 'hold' | 'off'; holdReason: string | null }>(`/api/ai/overview?conversation=${conversationId}`);
    setSt(r.ok ? { enabled: r.enabled, status: r.status, holdReason: r.holdReason } : null);
  }, [conversationId]);
  useEffect(() => {
    setSt(null);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!conversationId || !st || !st.enabled) return null;
  const act = async (action: 'resume' | 'pause') => {
    setBusy(true);
    await api('/api/ai/overview', { method: 'POST', body: JSON.stringify({ action, conversationId }) });
    await load();
    setBusy(false);
  };
  const look = st.status === 'active'
    ? { bg: 'var(--teal-bg)', fg: 'var(--teal-ink)', text: compact ? 'AI on' : 'Assistant on', title: 'The assistant is answering this chat. Click to switch it off here.', next: 'pause' as const }
    : st.status === 'hold'
      ? { bg: 'var(--amber-bg)', fg: 'var(--amber)', text: compact ? 'Needs you' : 'Needs you · give back', title: `${st.holdReason || 'The assistant stopped here.'} Click to give the chat back to it.`, next: 'resume' as const }
      : { bg: 'var(--surface-3)', fg: 'var(--muted)', text: compact ? 'AI off' : 'Assistant off', title: 'The assistant is off for this chat. Click to switch it back on.', next: 'resume' as const };
  return (
    <button
      type="button" disabled={busy} onClick={() => act(look.next)} title={look.title} aria-label={look.title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 9px', borderRadius: 99, border: 0, background: look.bg, color: look.fg, fontSize: 11, fontWeight: 750, cursor: busy ? 'default' : 'pointer', flex: 'none', whiteSpace: 'nowrap', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}
    >
      <Bot size={13} /> {look.text}
    </button>
  );
}
