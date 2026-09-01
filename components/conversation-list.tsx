'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, X, Check, CheckCheck, Star, Clock, AlertCircle } from 'lucide-react';
import { getStageMeta, getVisaMeta } from '@/lib/types';
import { initialsOf, avatarTint, formatPhone, matchKey } from '@/lib/phone';
import type { Contact } from '@/lib/contacts';

type Filter = 'all' | 'unread' | 'hot' | 'cold' | 'spotlight' | 'won';

// Chats mode is the inbox: smart tags, exactly as requested.
const CHAT_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'hot', label: 'Hot' },
  { key: 'cold', label: 'Cold' },
  { key: 'spotlight', label: '★ Spotlight' },
];
// Contacts mode is the phonebook for STARTING a chat with any lead.
const CONTACT_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'hot', label: 'Hot' },
  { key: 'cold', label: 'Cold' },
  { key: 'won', label: 'Won' },
];

/**
 * The real delivery state of the last message, not decoration.
 *
 * WhatsApp blue (#34B7F1) for read is deliberate: everyone already knows what
 * it means, so no one has to learn a new colour. Grey single = sent, grey
 * double = delivered, blue double = they read it.
 */
function RowTicks({ status }: { status: string | null }) {
  if (status === 'queued') return <Clock size={12} style={{ flex: 'none', opacity: 0.6 }} />;
  if (status === 'failed') return <AlertCircle size={12} style={{ flex: 'none', color: 'var(--red)' }} />;
  if (status === 'read') return <CheckCheck size={13} style={{ flex: 'none', color: '#34B7F1' }} />;
  if (status === 'delivered') return <CheckCheck size={12} style={{ flex: 'none', opacity: 0.55 }} />;
  if (status === 'sent') return <Check size={12} style={{ flex: 'none', opacity: 0.55 }} />;
  // NULL = migration 104 has not run yet, so the column holds nothing. Showing
  // a single tick here would be a lie (it reads as "sent, not delivered"), so
  // fall back to the neutral double tick until real status is available.
  return <CheckCheck size={12} style={{ flex: 'none', opacity: 0.45 }} />;
}

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
  contacts,
  mode,
  selectedKey,
  onSelect,
  loading,
  isMobile,
}: {
  contacts: Contact[];
  mode: 'chats' | 'contacts';
  selectedKey: string | null;
  onSelect: (c: Contact) => void;
  loading?: boolean;
  isMobile?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const FILTERS = mode === 'chats' ? CHAT_FILTERS : CONTACT_FILTERS;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = matchKey(query);

    return contacts.filter((c) => {
      if (filter === 'unread' && c.unread === 0) return false;
      if (filter === 'hot' && c.lead?.stage !== 'hot') return false;
      if (filter === 'cold' && c.lead?.stage !== 'cold') return false;
      if (filter === 'won' && c.lead?.stage !== 'won') return false;
      if (filter === 'spotlight' && !c.spotlight) return false;

      if (!q) return true;
      if (qDigits && matchKey(c.phoneE164) === qDigits) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.phoneE164 || '').toLowerCase().includes(q) ||
        (c.lead?.email || '').toLowerCase().includes(q)
      );
    });
  }, [contacts, query, filter]);

  // Switching between Chats and Contacts resets a filter the other mode lacks.
  // This MUST be an effect: setting state inside a useMemo re-renders during
  // render, which is what made the window judder on open.
  useEffect(() => {
    if (!FILTERS.some((f) => f.key === filter)) setFilter('all');
  }, [mode, filter, FILTERS]);

  return (
    <div
      style={{
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
      <div style={{ padding: '13px 14px 10px', borderBottom: '1px solid var(--line-2)' }}>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'chats' ? 'Search chats' : 'Search name, phone or email'}
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

      <div style={{ padding: '8px 15px', fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>
        {loading ? 'Loading…' : `${visible.length.toLocaleString('en-IN')} ${mode === 'chats' ? (visible.length === 1 ? 'chat' : 'chats') : (visible.length === 1 ? 'contact' : 'contacts')}`}
        {!loading && visible.length !== contacts.length && (
          <span style={{ fontWeight: 500 }}> of {contacts.length.toLocaleString('en-IN')}</span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {!loading && visible.length === 0 && (
          <div style={{ padding: '38px 24px', textAlign: 'center', color: 'var(--muted)' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 5 }}>
              {mode === 'chats' && !query && filter === 'all' ? 'No conversations yet' : 'Nothing matches'}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              {query
                ? <>Nothing matches “{query}”.</>
                : mode === 'chats' && filter === 'all'
                ? 'Start one from the Contacts tab, or wait for a client to message you.'
                : 'Nothing in this filter yet.'}
            </div>
          </div>
        )}

        {visible.map((c) => {
          const on = selectedKey === c.key;
          const stage = c.lead ? getStageMeta(c.lead.stage) : null;
          const visa = getVisaMeta(c.lead?.visa_type);
          const hasThread = !!c.lastMessageAt;

          return (
            <button
              key={c.key}
              onClick={() => onSelect(c)}
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
                  background: c.unknown ? 'var(--surface-3)' : avatarTint(c.key),
                  color: c.unknown ? 'var(--muted)' : '#fff',
                  border: c.unknown ? '1px dashed var(--line)' : 'none',
                  fontSize: 13,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 'none',
                }}
              >
                {c.unknown ? '?' : initialsOf(c.name)}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: c.unread > 0 ? 700 : 600,
                      color: 'var(--ink)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {c.unknown ? formatPhone(c.phoneE164) : c.name}
                  </span>
                  <span style={{ fontSize: 11, color: c.unread > 0 ? 'var(--teal)' : 'var(--muted)', flex: 'none', fontWeight: c.unread > 0 ? 700 : 400 }}>
                    {ago(c.lastMessageAt || c.lead?.updated_at || null)}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  {/* A thread shows its last message; everyone else shows their number. */}
                  <span
                    style={{
                      fontSize: 12,
                      color: c.unread > 0 ? 'var(--ink-2)' : 'var(--muted)',
                      fontWeight: c.unread > 0 ? 600 : 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {hasThread && c.lastDirection === 'out' && <RowTicks status={c.lastStatus} />}
                    {hasThread ? c.lastPreview || '[media]' : formatPhone(c.phoneE164)}
                  </span>

                  {c.spotlight && (
                    <Star size={12} style={{ color: 'var(--amber)', fill: 'var(--amber)', flex: 'none' }} />
                  )}
                  {c.unread > 0 && (
                    <span
                      style={{
                        minWidth: 18,
                        height: 18,
                        padding: '0 5px',
                        borderRadius: 99,
                        background: 'var(--teal)',
                        color: '#fff',
                        fontSize: 10.5,
                        fontWeight: 800,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flex: 'none',
                      }}
                    >
                      {c.unread > 99 ? '99+' : c.unread}
                    </span>
                  )}

                  {c.unknown && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'var(--amber-bg)', color: 'var(--amber)', flex: 'none' }}>
                      Not in CRM
                    </span>
                  )}
                  {visa && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: visa.bg, color: visa.fg, flex: 'none' }}>
                      {visa.short}
                    </span>
                  )}
                  {stage && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: stage.bg, color: stage.fg, flex: 'none' }}>
                      {stage.label}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
