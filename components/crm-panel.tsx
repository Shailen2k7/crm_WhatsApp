'use client';

import { ExternalLink, FileDown, Mail, Phone, Calendar, Tag, Briefcase, UserCircle, X } from 'lucide-react';
import type { Lead } from '@/lib/types';
import { getStageMeta, getVisaMeta } from '@/lib/types';
import { initialsOf, avatarTint, formatPhone } from '@/lib/phone';

const CRM_URL = 'https://crm.migrizo.com';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function CrmPanel({
  lead,
  memberName,
  onClose,
}: {
  lead: Lead;
  memberName: (id: string | null) => string;
  onClose?: () => void;
}) {
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
