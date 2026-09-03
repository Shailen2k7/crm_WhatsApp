'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { ExternalLink, FileDown, Mail, Phone, Calendar, Tag, Briefcase, UserCircle, X, Loader2, Pause, Play, Workflow } from 'lucide-react';
import type { Lead } from '@/lib/types';
import { getStageMeta, getVisaMeta } from '@/lib/types';
import type { Contact } from '@/lib/contacts';
import { initialsOf, avatarTint, formatPhone } from '@/lib/phone';

const CRM_URL = 'https://crm.migrizo.com';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function CrmPanel({
  contact,
  memberName,
  onClose,
}: {
  contact: Contact;
  memberName: (id: string | null) => string;
  onClose?: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  // LAST-RESORT LOOKUP. contact.lead is normally already resolved. But a
  // conversation can carry a lead_id whose lead is not in the loaded set, and
  // showing "Not in CRM" for somebody the CRM plainly knows is the worst
  // possible answer — so we go and fetch them by phone before saying it.
  const [fetched, setFetched] = useState<Lead | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    setFetched(null);

    // Leads that arrived through the background pages carry only the handful of
    // columns the chat list needs — pulling the rest for thousands of rows was
    // blocking the main thread mid-scroll. `email` is absent (not null) on such
    // a row, which is how we tell a light row from a complete one, and that is
    // the cue to fetch the full record for just this one person.
    const isLightRow = !!contact.lead && !('email' in (contact.lead as object));
    if ((contact.lead && !isLightRow) || !contact.phoneE164) return;

    let cancelled = false;
    setLooking(true);
    (async () => {
      const last10 = contact.phoneE164!.replace(/\D/g, '').slice(-10);
      let row: Lead | null = null;

      // Straight to it when we already know which lead this is.
      if (contact.lead?.id) {
        const { data } = await supabase.from('leads').select('*').eq('id', contact.lead.id).maybeSingle();
        row = (data as Lead) || null;
      }
      if (!row && contact.conversation?.lead_id) {
        const { data } = await supabase.from('leads').select('*').eq('id', contact.conversation.lead_id).maybeSingle();
        row = (data as Lead) || null;
      }
      if (!row && last10.length === 10) {
        // Same last-10 rule the database uses, so the UI never disagrees with it.
        const { data } = await supabase.from('leads').select('*').ilike('phone', `%${last10}`).limit(1);
        row = (data && data[0] as Lead) || null;
      }
      if (!cancelled) { setFetched(row); setLooking(false); }
    })();
    return () => { cancelled = true; };
  }, [supabase, contact]);

  // The fetched row is the complete one; prefer it over a light list row.
  const lead = fetched ?? contact.lead;

  if (!lead) {
    if (looking) {
      return (
        <aside style={{ width: 300, maxWidth: '86vw', flex: 'none', borderLeft: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader2 size={18} style={{ animation: 'spin .8s linear infinite', color: 'var(--muted)' }} />
        </aside>
      );
    }
    return <UnknownPanel contact={contact} onClose={onClose} />;
  }

  const stage = getStageMeta(lead.stage);
  const visa = getVisaMeta(lead.visa_type);

  const fields: { icon: typeof Mail; label: string; value: string; href?: string }[] = [
    { icon: Phone, label: 'Phone', value: formatPhone(lead.phone), href: lead.phone ? `tel:${lead.phone}` : undefined },
    { icon: Mail, label: 'Email', value: lead.email || '—', href: lead.email ? `mailto:${lead.email}` : undefined },
    { icon: Briefcase, label: 'Industry', value: lead.industry ? titleise(lead.industry) : '—' },
    { icon: Tag, label: 'Source', value: lead.source || '—' },
    { icon: UserCircle, label: 'Owner', value: memberName(lead.owner_id) },
    { icon: Calendar, label: 'Added', value: fmtDate(lead.created_at) },
    { icon: Calendar, label: 'Next follow-up', value: fmtDate(lead.next_follow_up) },
    { icon: Calendar, label: 'First replied', value: lead.first_response_at ? fmtDate(lead.first_response_at) : 'Never replied' },
  ];

  return (
    <aside
      style={{
        // As a mobile sheet this must not exceed the viewport, hence the max.
        width: 300,
        maxWidth: '86vw',
        flex: 'none',
        borderLeft: '1px solid var(--line)',
        background: 'var(--surface)',
        overflowY: 'auto',
        minHeight: 0,
      }}
    >
      {onClose && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 12px 0' }}>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: 8, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Identity */}
      <div style={{ padding: '22px 18px 16px', textAlign: 'center', borderBottom: '1px solid var(--line-2)' }}>
        <div
          style={{
            width: 62,
            height: 62,
            borderRadius: 99,
            background: avatarTint(lead.id),
            color: '#fff',
            fontSize: 21,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 11px',
          }}
        >
          {initialsOf(lead.full_name)}
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{lead.full_name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{formatPhone(lead.phone)}</div>

        <div style={{ display: 'flex', gap: 5, justifyContent: 'center', marginTop: 11, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: stage.bg, color: stage.fg }}>
            {stage.label}
          </span>
          {visa && (
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: visa.bg, color: visa.fg }} title={visa.full}>
              {visa.short}
            </span>
          )}
          {lead.is_sample && (
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: 'var(--surface-3)', color: 'var(--muted)' }}>
              Sample
            </span>
          )}
        </div>
      </div>

      {/* Fields */}
      <Section title="Details">
        {fields.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 0', alignItems: 'flex-start' }}>
            <f.icon size={14} style={{ color: 'var(--muted)', marginTop: 2, flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {f.label}
              </div>
              {f.href ? (
                <a href={f.href} style={{ fontSize: 12.8, fontWeight: 500, wordBreak: 'break-word' }}>
                  {f.value}
                </a>
              ) : (
                <div style={{ fontSize: 12.8, fontWeight: 500, color: 'var(--ink-2)', wordBreak: 'break-word' }}>{f.value}</div>
              )}
            </div>
          </div>
        ))}
      </Section>

      {/* Tags */}
      {lead.tags && lead.tags.length > 0 && (
        <Section title="Tags">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {lead.tags.map((t) => (
              <span key={t} style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: 'var(--surface-3)', color: 'var(--ink-2)' }}>
                {t}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Where this person is in the follow-up sequence, and the controls to
          pause or resume it for THEM without touching anyone else. */}
      <LeadSequence phone={contact.phoneE164 || lead.phone} />

      {/* Latest note */}
      {lead.last_note && (
        <Section title="Latest note">
          <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-2)', margin: 0, whiteSpace: 'pre-wrap' }}>{lead.last_note}</p>
          {lead.last_note_at && (
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>{fmtDate(lead.last_note_at)}</div>
          )}
        </Section>
      )}

      {/* CV — the file already archived by the CRM. */}
      {lead.cv_path && (
        <Section title="Documents">
          <a
            href={`${CRM_URL}/api/lead/cv/${lead.id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '9px 11px',
              borderRadius: 9,
              border: '1px solid var(--line)',
              background: 'var(--surface-2)',
              color: 'var(--ink)',
            }}
          >
            <FileDown size={16} style={{ color: 'var(--teal)', flex: 'none' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {lead.cv_name || 'CV on record'}
            </span>
          </a>
        </Section>
      )}

      {/* Back to the CRM */}
      <div style={{ padding: '4px 18px 22px' }}>
        <a
          href={`${CRM_URL}/leads`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            padding: '9px 14px',
            borderRadius: 9,
            border: '1px solid var(--line)',
            background: 'var(--surface-2)',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--ink-2)',
          }}
        >
          Open in CRM <ExternalLink size={13} />
        </a>
      </div>
    </aside>
  );
}


interface LeadSeqState {
  enrolled: boolean;
  sequenceExists?: boolean;
  sequenceName?: string;
  sequenceRunning?: boolean;
  status?: 'active' | 'completed' | 'replied' | 'skipped' | 'stopped';
  currentStep?: number;
  totalSteps?: number;
  nextTemplate?: string | null;
  nextSendAt?: string | null;
  exitReason?: string | null;
}

/** The follow-up sequence, for one person. */
function LeadSequence({ phone }: { phone: string | null | undefined }) {
  const [state, setState] = useState<LeadSeqState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!phone) { setState({ enrolled: false }); return; }
    try {
      const r = await fetch(`/api/automation/lead?phone=${encodeURIComponent(phone)}`);
      const j = await r.json();
      setState(j.ok ? j : { enrolled: false });
    } catch { setState({ enrolled: false }); }
  }, [phone]);

  useEffect(() => { load(); }, [load]);

  async function act(action: 'pause' | 'resume' | 'remove' | 'send_next' | 'add') {
    if (!phone || busy) return;
    if (action === 'remove' && !confirm('Take this person out of the follow-up sequence?\n\nThey keep every message already sent; nothing further goes out.')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/automation/lead', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, action }),
      });
      const j = await r.json();
      if (!j.ok) alert(j.error || 'Could not do that.');
      await load();
    } catch { alert('Could not reach the server.'); }
    setBusy(false);
  }

  if (!state) return null;

  // NOT ENROLLED — the old build returned null here, which is why the card was
  // invisible for everyone still queued behind the daily intake. You should be
  // able to act on any lead, so offer to put them in.
  if (!state.enrolled) {
    if (!state.sequenceExists) return null;
    return (
      <Section title="Follow-up sequence">
        <div style={{ fontSize: 12.2, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 10 }}>
          Not in the sequence yet — waiting their turn in the daily intake.
          Add them to start the {state.totalSteps}-message follow-up now.
        </div>
        <button
          onClick={() => act('add')}
          disabled={busy}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8,
            border: '1px solid var(--green)', background: 'transparent', color: 'var(--green)',
            fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Add to sequence
        </button>
      </Section>
    );
  }

  const paused = state.status === 'stopped';
  const active = state.status === 'active';
  const done = state.status === 'completed';
  const replied = state.status === 'replied';

  const TONE: Record<string, { label: string; bg: string; fg: string }> = {
    active:    { label: 'Active',    bg: 'var(--green-bg)',  fg: 'var(--green)' },
    stopped:   { label: 'Paused',    bg: 'var(--amber-bg)',  fg: '#B45309' },
    completed: { label: 'Finished',  bg: 'var(--surface-3)', fg: 'var(--muted)' },
    replied:   { label: 'Replied',   bg: 'var(--teal-bg)',   fg: 'var(--teal-ink)' },
    skipped:   { label: 'Skipped',   bg: 'var(--red-bg)',    fg: 'var(--red)' },
  };
  const tone = TONE[state.status || 'active'] || TONE.active;

  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 8,
    border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)',
    fontSize: 11.8, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
  };

  return (
    <Section title="Follow-up sequence">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <Workflow size={13} style={{ color: 'var(--green)', flex: 'none' }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)' }}>
          Message {Math.min((state.currentStep || 0) + (active ? 1 : 0), state.totalSteps || 0) || state.currentStep} of {state.totalSteps}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: tone.bg, color: tone.fg }}>
          {tone.label}
        </span>
      </div>

      <div style={{ fontSize: 11.6, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 10 }}>
        {replied  && 'They answered, so the sequence stopped for them.'}
        {done     && 'They received every message.'}
        {paused   && (state.exitReason?.includes('hand') ? 'Paused — nothing further goes out until you resume.' : `Stopped — ${state.exitReason}.`)}
        {active   && (state.nextSendAt
          ? <>Next: <b style={{ color: 'var(--ink-2)' }}>{state.nextTemplate}</b> on {fmtDate(state.nextSendAt)}</>
          : 'Waiting for the next message.')}
        {state.status === 'skipped' && `Skipped — ${state.exitReason}.`}
      </div>

      {/* Controls for EVERY state, not just the active ones. A lead who replied
          or was skipped still needs a way back in — previously this rendered
          nothing at all for them, which looked like the feature was missing. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {active && (
          <>
            <button onClick={() => act('pause')} disabled={busy} style={btn}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />} Pause
            </button>
            <button onClick={() => act('send_next')} disabled={busy} style={btn} title="Send the next message on the next check instead of waiting">
              Send next now
            </button>
          </>
        )}

        {/* paused by hand, opted out, replied, or skipped — all can go back in,
            continuing from the step they reached rather than starting over. */}
        {!active && !done && (
          <button
            onClick={() => act('resume')}
            disabled={busy}
            title={replied ? 'Put them back in the sequence, continuing from where they stopped' : 'Resume the follow-up'}
            style={{ ...btn, borderColor: 'var(--green)', color: 'var(--green)' }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {replied ? 'Restart follow-up' : 'Resume'}
          </button>
        )}

        <button onClick={() => act('remove')} disabled={busy} style={{ ...btn, color: 'var(--red)' }}>
          {done ? 'Clear' : 'Remove'}
        </button>
      </div>

      {active && state.sequenceRunning === false && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
          The sequence itself is not running, so nothing sends right now.
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-2)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function titleise(s: string): string {
  const cleaned = s.replace(/[_\-+]+/g, ' ').trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}


/** Shown when a conversation has no CRM record behind it. */
function UnknownPanel({ contact, onClose }: { contact: Contact; onClose?: () => void }) {
  return (
    <aside
      style={{
        width: 300,
        maxWidth: '86vw',
        flex: 'none',
        borderLeft: '1px solid var(--line)',
        background: 'var(--surface)',
        overflowY: 'auto',
        minHeight: 0,
      }}
    >
      {onClose && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 12px 0' }}>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: 8, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div style={{ padding: '22px 18px 16px', textAlign: 'center', borderBottom: '1px solid var(--line-2)' }}>
        <div
          style={{
            width: 62,
            height: 62,
            borderRadius: 99,
            background: 'var(--surface-3)',
            border: '1px dashed var(--line)',
            color: 'var(--muted)',
            fontSize: 24,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 11px',
          }}
        >
          ?
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{formatPhone(contact.phoneE164)}</div>
        <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: 'var(--amber-bg)', color: 'var(--amber)', marginTop: 8 }}>
          Not in CRM
        </span>
      </div>

      <div style={{ padding: '16px 18px' }}>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 14px' }}>
          This number messaged you but has no lead record. The conversation is saved
          and will link itself automatically once a lead with this number exists.
        </p>
        <a
          href={`${CRM_URL}/leads`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            padding: '9px 14px',
            borderRadius: 9,
            border: '1px solid var(--line)',
            background: 'var(--surface-2)',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--ink-2)',
          }}
        >
          Add as a lead in CRM <ExternalLink size={13} />
        </a>
      </div>
    </aside>
  );
}
