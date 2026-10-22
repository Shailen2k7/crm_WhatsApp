'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { ExternalLink, FileDown, Mail, Phone, Calendar, Tag, Briefcase, UserCircle, X, Loader2, Link2, UserPlus, Sparkles, Check } from 'lucide-react';
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
    return (
      <UnknownPanel
        contact={contact}
        onClose={onClose}
        onLinked={async (leadId) => {
          const { data } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle();
          if (data) setFetched(data as Lead);
        }}
      />
    );
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

      <NurtureCard phone={contact.phoneE164 || lead.phone} hotOrSpotlight={lead.stage === 'hot' || !!(lead as { is_spotlight?: boolean }).is_spotlight || contact.spotlight} />

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
/**
 * THE END OF A DEAD-END PANEL. "Not in CRM" used to say: go to the CRM and do
 * it yourself. Now the panel reads the chat's own enquiry message, says who
 * this almost certainly is, and fixes it in one click:
 *
 *   enquiry + exactly one matching lead  → "This is <name>" + Link
 *   enquiry + several possible leads     → the shortlist, pick one
 *   enquiry + nobody                     → their form details + Create lead
 *   plain chat, no enquiry               → type a name + Create lead
 *
 * Linking is the server's job (/api/whatsapp/link-lead) and it re-checks
 * everything, so a stale panel can never cross-link two people.
 */
interface LinkCandidate { id: string; full_name: string | null; phone: string | null; email: string | null; stage: string | null }
interface LinkInfo {
  parsed: { fullName: string | null; formPhone: string | null; email: string | null; expertise: string | null; investmentReadiness: string | null } | null;
  candidates: LinkCandidate[];
  alreadyLinked?: string;
}

function UnknownPanel({ contact, onClose, onLinked }: { contact: Contact; onClose?: () => void; onLinked: (leadId: string) => void }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');

  useEffect(() => {
    setInfo(null); setError(null); setDone(null); setNameDraft(''); setEmailDraft('');
    if (!contact.conversationId) { setInfo({ parsed: null, candidates: [] }); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/whatsapp/link-lead?conversationId=${contact.conversationId}`, { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (!json.ok) { setError(json.error || 'Could not read this chat.'); setInfo({ parsed: null, candidates: [] }); return; }
        if (json.alreadyLinked) { onLinked(json.alreadyLinked); return; }
        setInfo({ parsed: json.parsed, candidates: json.candidates || [] });
      } catch {
        if (!cancelled) { setError('Could not read this chat.'); setInfo({ parsed: null, candidates: [] }); }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.conversationId]);

  async function act(body: Record<string, unknown>, successName: string | null) {
    if (!contact.conversationId || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/whatsapp/link-lead', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: contact.conversationId, ...body }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not save.'); return; }
      setDone(json.leadName || successName || 'Linked');
      // A short beat so the person SEES it worked, then the full lead panel.
      setTimeout(() => onLinked(json.leadId), 650);
    } catch {
      setError('Network error — nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const parsed = info?.parsed ?? null;
  const candidates = info?.candidates ?? [];

  return (
    <aside style={{ width: 300, maxWidth: '86vw', flex: 'none', borderLeft: '1px solid var(--line)', background: 'var(--surface)', overflowY: 'auto', minHeight: 0 }}>
      {onClose && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 12px 0' }}>
          <button onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
      )}

      <div style={{ padding: '22px 18px 16px', textAlign: 'center', borderBottom: '1px solid var(--line-2)' }}>
        <div style={{ width: 62, height: 62, borderRadius: 99, background: 'var(--surface-3)', border: '1px dashed var(--line)', color: 'var(--muted)', fontSize: 24, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 11px' }}>
          ?
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{parsed?.fullName || formatPhone(contact.phoneE164)}</div>
        {parsed?.fullName && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{formatPhone(contact.phoneE164)}</div>}
        <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: 'var(--amber-bg)', color: 'var(--amber)', marginTop: 8 }}>
          Not in CRM
        </span>
      </div>

      <div style={{ padding: '16px 18px' }}>
        {done ? (
          <div className="animate-pop-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '26px 0', textAlign: 'center' }}>
            <div style={{ width: 44, height: 44, borderRadius: 99, background: 'var(--teal)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Check size={22} />
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{done}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Linked to the CRM</div>
          </div>
        ) : !info ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '22px 0', color: 'var(--muted)', fontSize: 12.5 }}>
            <Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} /> Reading the chat…
          </div>
        ) : (
          <>
            {parsed && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 13px', marginBottom: 14, background: 'var(--surface-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 8 }}>
                  <Sparkles size={11} /> From their enquiry form
                </div>
                {[
                  ['Name', parsed.fullName],
                  ['Form phone', parsed.formPhone && formatPhone(parsed.formPhone)],
                  ['Email', parsed.email],
                  ['Expertise', parsed.expertise],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k as string} style={{ display: 'flex', gap: 8, fontSize: 12.3, padding: '2.5px 0' }}>
                    <span style={{ color: 'var(--muted)', flex: 'none', width: 78 }}>{k}</span>
                    <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{v}</span>
                  </div>
                ))}
                {parsed.investmentReadiness && (
                  <span style={{ display: 'inline-block', marginTop: 7, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: parsed.investmentReadiness === 'yes' ? 'var(--teal-bg)' : 'var(--surface-3)', color: parsed.investmentReadiness === 'yes' ? 'var(--teal-ink)' : 'var(--muted)' }}>
                    {parsed.investmentReadiness === 'yes' ? 'Ready to invest £7,000' : `Invest: ${parsed.investmentReadiness}`}
                  </span>
                )}
              </div>
            )}

            {error && <div style={{ background: 'var(--red-bg)', color: 'var(--red)', padding: '8px 11px', borderRadius: 9, fontSize: 12, marginBottom: 10 }}>{error}</div>}

            {candidates.length > 0 ? (
              <>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 10px' }}>
                  {candidates.length === 1
                    ? <>This chat matches an existing lead — they filled the form with a different number.</>
                    : <>{candidates.length} leads could be this person — pick the right one.</>}
                </p>
                {candidates.map((c) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--line)', borderRadius: 11, padding: '10px 12px', marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.full_name || '—'}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{formatPhone(c.phone)}{c.stage ? ` · ${c.stage}` : ''}</div>
                    </div>
                    <button
                      onClick={() => act({ leadId: c.id }, c.full_name)}
                      disabled={busy}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 9, border: 0, background: 'var(--teal)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 'none' }}
                    >
                      {busy ? <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> : <Link2 size={12} />} Link
                    </button>
                  </div>
                ))}
              </>
            ) : parsed ? (
              <>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 12px' }}>
                  No lead in the CRM matches this enquiry — create one from the form above.
                </p>
                <button
                  onClick={() => act({ create: {} }, parsed.fullName)}
                  disabled={busy}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', padding: '10px 14px', borderRadius: 10, border: 0, background: 'var(--teal)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                >
                  {busy ? <Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} /> : <UserPlus size={14} />}
                  Add {parsed.fullName ? parsed.fullName.split(/\s+/)[0] : 'them'} to the CRM
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 12px' }}>
                  This number messaged you but has no lead record. Add them with a name — the chat links itself.
                </p>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Full name"
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--surface-2)', outline: 'none', fontSize: 13, marginBottom: 8 }}
                />
                <input
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  placeholder="Email (optional)"
                  inputMode="email"
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--surface-2)', outline: 'none', fontSize: 13, marginBottom: 10 }}
                />
                <button
                  onClick={() => act({ create: { name: nameDraft, email: emailDraft } }, nameDraft)}
                  disabled={busy || !nameDraft.trim()}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', padding: '10px 14px', borderRadius: 10, border: 0, background: nameDraft.trim() ? 'var(--teal)' : 'var(--surface-3)', color: nameDraft.trim() ? '#fff' : 'var(--muted)', fontSize: 13, fontWeight: 700, cursor: nameDraft.trim() ? 'pointer' : 'not-allowed' }}
                >
                  {busy ? <Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} /> : <UserPlus size={14} />}
                  Add as a lead
                </button>
              </>
            )}

            <a
              href={`${CRM_URL}/leads`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}
            >
              Open the CRM instead <ExternalLink size={11} />
            </a>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * THE NURTURE, FROM INSIDE THE CHAT. For a Hot or Spotlight lead the side
 * panel says where they stand in HS1→HS8 — what is next and when — with one
 * button to pause them and one to resume. The same server call the Automation
 * tab uses, so the two can never tell different stories.
 */
function NurtureCard({ phone, hotOrSpotlight }: { phone: string | null; hotOrSpotlight: boolean }) {
  const [st, setSt] = useState<{
    inAudience: boolean; paused?: boolean; spotlight?: boolean; done?: number; total?: number;
    state?: string; nextStep?: string | null; nextAt?: string | null; stoppedReason?: string | null; phoneE164?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!phone) { setSt({ inAudience: false }); return; }
    try {
      const res = await fetch(`/api/automation/nurture?phone=${encodeURIComponent(phone)}`, { cache: 'no-store' });
      const json = await res.json();
      setSt(json.ok ? json : { inAudience: false });
    } catch { setSt({ inAudience: false }); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSt(null); load(); }, [phone]);

  if (!hotOrSpotlight || !st || !st.inAudience) return null;

  const stepNo = st.nextStep ? st.nextStep.replace('nurture_hs', 'HS') : null;
  const when = st.nextAt ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(st.nextAt)) : null;
  const line = st.state === 'stopped' ? `Ended — ${st.stoppedReason}`
    : st.state === 'finished' ? 'Series complete — all 8 messages sent'
    : st.paused ? `Paused — ${stepNo ?? 'the series'} waits for Resume`
    : st.state === 'due' ? `${stepNo} goes out today` 
    : st.state === 'silence' ? `${stepNo} waits — they're in a conversation`
    : st.state === 'ecosystem' ? `${stepNo} waits — Meta pause until ${when}`
    : stepNo ? `${stepNo} around ${when}` : 'Waiting';

  async function toggle() {
    if (!st?.phoneE164) return;
    setBusy(true);
    try {
      const res = await fetch('/api/automation/nurture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: st.paused ? 'resume' : 'pause', phone: st.phoneE164 }),
      });
      const json = await res.json();
      if (json.ok) await load();
      else alert(json.error || 'Could not save.');
    } finally { setBusy(false); }
  }

  const active = st.state !== 'stopped' && st.state !== 'finished';
  return (
    <div style={{ margin: '12px 16px 0', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>
            Nurture · {st.done}/{st.total} sent{st.spotlight ? ' · ★' : ''}
          </div>
          <div style={{ fontSize: 12.3, fontWeight: 600, marginTop: 3, color: st.paused ? 'var(--amber)' : 'var(--ink-2)', lineHeight: 1.45 }}>{line}</div>
        </div>
        {active && (
          <button
            onClick={toggle}
            disabled={busy}
            style={{ padding: '6px 12px', borderRadius: 8, border: 0, flex: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
              background: st.paused ? 'var(--teal)' : 'var(--amber-bg)', color: st.paused ? '#fff' : 'var(--amber)' }}
          >
            {busy ? '…' : st.paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </div>
      {/* the series at a glance */}
      <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
        {Array.from({ length: st.total || 8 }, (_, i) => (
          <span key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i < (st.done || 0) ? 'var(--teal)' : 'var(--line)' }} />
        ))}
      </div>
    </div>
  );
}
