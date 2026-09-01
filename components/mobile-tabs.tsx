'use client';

// =============================================================================
// MOBILE NAVIGATION — a bottom tab bar, not a side rail.
// -----------------------------------------------------------------------------
// A 62px vertical rail is a DESKTOP pattern. On a phone it steals a sixth of
// the width for navigation nobody looks at, and puts the controls at the top
// where a thumb cannot reach. Every serious mobile app — WhatsApp included —
// puts navigation at the bottom, and so does this.
//
// It hides while a chat is open: the conversation then owns the whole screen,
// and the back arrow in the header is the way out.
// =============================================================================
import { MessageSquare, Users, FileText, Zap, Settings } from 'lucide-react';
import type { RailKey } from './rail';

const TABS: { key: RailKey; label: string; Icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Chats', Icon: MessageSquare },
  { key: 'contacts', label: 'Contacts', Icon: Users },
  { key: 'files', label: 'Files', Icon: FileText },
  { key: 'quickreplies', label: 'Replies', Icon: Zap },
  { key: 'settings', label: 'Settings', Icon: Settings },
];

export function MobileTabs({
  active,
  onSelect,
  unread,
}: {
  active: RailKey;
  onSelect: (k: RailKey) => void;
  unread: number;
}) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--surface)',
        borderTop: '1px solid var(--line)',
        // The home indicator sits inside the viewport on modern iPhones; without
        // this inset the tabs are half-covered by it.
        paddingBottom: 'env(safe-area-inset-bottom)',
        flex: 'none',
        zIndex: 20,
      }}
    >
      {TABS.map(({ key, label, Icon }) => {
        const on = active === key || (key === 'chat' && active === 'starred');
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            aria-label={label}
            aria-current={on ? 'page' : undefined}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              padding: '9px 0 7px',
              border: 0,
              background: 'transparent',
              color: on ? 'var(--teal)' : 'var(--muted)',
              cursor: 'pointer',
              minHeight: 54,
            }}
          >
            <span style={{ position: 'relative', display: 'flex' }}>
              <Icon size={21} strokeWidth={on ? 2.2 : 1.7} />
              {key === 'chat' && unread > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -9,
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    borderRadius: 99,
                    background: 'var(--teal)',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 800,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '2px solid var(--surface)',
                  }}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: on ? 700 : 500, letterSpacing: '.01em' }}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The top bar on a phone. Exists so the status bar (clock, battery) never sits
 * on top of the search field — the inset below is what was missing.
 */
export function MobileHeader({
  title,
  theme,
  onToggleTheme,
  userName,
  right,
}: {
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  userName: string;
  right?: React.ReactNode;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        paddingTop: 'calc(10px + env(safe-area-inset-top))',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--line-2)',
        flex: 'none',
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: 'linear-gradient(140deg,#16b59f,#0a6e62)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19V7a3 3 0 013-3h10a3 3 0 013 3v6a3 3 0 01-3 3H8z" />
        </svg>
      </div>
      <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.01em', flex: 1 }}>{title}</span>
      {right}
      <button
        onClick={onToggleTheme}
        aria-label="Toggle theme"
        style={{ width: 36, height: 36, borderRadius: 10, border: 0, background: 'transparent', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}
      >
        {theme === 'dark' ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></svg>
        )}
      </button>
      <div
        title={userName}
        style={{ width: 30, height: 30, borderRadius: 99, background: 'var(--teal)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}
      >
        {(userName || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'}
      </div>
    </header>
  );
}
