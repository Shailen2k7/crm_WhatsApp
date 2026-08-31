'use client';

import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Lead } from '@/lib/types';
import { getStageMeta, getVisaMeta } from '@/lib/types';
import { initialsOf, avatarTint, formatPhone, matchKey } from '@/lib/phone';

type Filter = 'all' | 'hot' | 'unreplied' | 'won';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'hot', label: 'Hot' },
  { key: 'unreplied', label: 'Never replied' },
  { key: 'won', label: 'Won' },
];

/** "3d", "2h", "just now" — compact enough for a list row. */
function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

export function ConversationList({
  leads,
  selectedId,
  onSelect,
  loading,
  isMobile,
}: {
  leads: Lead[];
  selectedId: string | null;
  onSelect: (lead: Lead) => void;
  loading?: boolean;
  isMobile?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = matchKey(query);

    return leads.filter((l) => {
      if (filter === 'hot' && l.stage !== 'hot') return false;
      if (filter === 'won' && l.stage !== 'won') return false;
      if (filter === 'unreplied' && l.first_response_at) return false;

      if (!q) return true;
      // A number typed in any format should find the person — same last-10
      // rule the CRM uses, so search matches what the database matches.
      if (qDigits && matchKey(l.phone) === qDigits) return true;
      return (
        l.full_name.toLowerCase().includes(q) ||
        (l.phone || '').toLowerCase().includes(q) ||
        (l.email || '').toLowerCase().includes(q)
      );
    });
  }, [leads, query, filter]);

  return (
    <div
      style={{
        // On a phone the list IS the screen; a fixed 340px would overflow the
        // viewport and clip the stage badges off the right edge.
        width: isMobile ? '100%' : 340,
        flex: isMobile ? 1 : 'none',
        minWidth: 0,
        borderRight: isMobile ? 'none' : '1px solid var(--line)',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Search */}
      <div style={{ padding: '13px 14px 10px', borderBottom: '1px solid var(--line-2)' }}>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, phone or email"
            style={{
              width: '100%',
              padding: '9px 30px 9px 33px',
              borderRadius: 9,
              border: '1px solid var(--line)',
              background: 'var(--surface-2)',
              outline: 'none',
              fontSize: 13,
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 5, marginTop: 10, overflowX: 'auto' }}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  padding: '4px 11px',
                  borderRadius: 99,
                  border: '1px solid ' + (on ? 'transparent' : 'var(--line)'),
                  background: on ? 'var(--teal)' : 'transparent',
                  color: on ? '#fff' : 'var(--ink-2)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flex: 'none',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Count */}
      <div style={{ padding: '8px 15px', fontSize: 11.5, color: 'var(--muted)', fontWeight: 600, letterSpacing: '.02em' }}>
        {loading ? 'Loading…' : `${visible.length.toLocaleString('en-IN')} ${visible.length === 1 ? 'contact' : 'contacts'}`}
        {!loading && visible.length !== leads.length && (
          <span style={{ fontWeight: 500 }}> of {leads.length.toLocaleString('en-IN')}</span>
        )}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading &&
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', gap: 11, padding: '11px 15px', alignItems: 'center' }}>
              <div className="skeleton" style={{ width: 40, height: 40, borderRadius: 99, flex: 'none' }} />
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ height: 11, width: '55%', borderRadius: 4, marginBottom: 7 }} />
                <div className="skeleton" style={{ height: 10, width: '80%', borderRadius: 4 }} />
              </div>
            </div>
          ))}

        {!loading && visible.length === 0 && (
          <div style={{ padding: '38px 24px', textAlign: 'center', color: 'var(--muted)' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 5 }}>Nothing matches</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              {query ? <>No contact matches “{query}”.</> : 'No contacts in this filter.'}
            </div>
          </div>
        )}

        {!loading &&
          visible.map((l) => {
            const on = selectedId === l.id;
            const stage = getStageMeta(l.stage);
            const visa = getVisaMeta(l.visa_type);
            return (
              <button
                key={l.id}
                onClick={() => onSelect(l)}
                style={{
                  width: '100%',
                  display: 'flex',
                  gap: 11,
                  padding: '11px 15px',
                  alignItems: 'center',
                  border: 0,
                  borderBottom: '1px solid var(--line-2)',
                  background: on ? 'var(--surface-3)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 99,
                    background: avatarTint(l.id),
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                  }}
                >
                  {initialsOf(l.full_name)}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                    <span
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {l.full_name}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', flex: 'none' }}>{ago(l.updated_at)}</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {formatPhone(l.phone)}
                    </span>
                    {visa && (
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: visa.bg, color: visa.fg, flex: 'none' }}>
                        {visa.short}
                      </span>
                    )}
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: stage.bg, color: stage.fg, flex: 'none' }}>
                      {stage.label}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
}
