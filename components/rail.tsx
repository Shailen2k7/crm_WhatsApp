'use client';

import { MessageSquare, Users, FileText, Zap, LayoutTemplate, Settings, Moon, Sun } from 'lucide-react';
import { initialsOf, avatarTint } from '@/lib/phone';

// The menu holds only what the team actually opens. Removed on request:
//  - 'automation' (30 Sep 2026): the app is a manual chat now.
//  - 'starred': Spotlight lives as a chip inside the chat list, where the
//    chats are — a second entrance to the same list confused more than it helped.
//  - 'team': the page never existed (it was a placeholder).
//  - the pin ("Keep open") and "Open CRM" rows: never used. The rail widens on
//    hover, and the logo up top still reaches the CRM.
export type RailKey = 'chat' | 'contacts' | 'files' | 'quickreplies' | 'templates' | 'settings';

const ITEMS: { key: RailKey; label: string; Icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Chats', Icon: MessageSquare },
  { key: 'contacts', label: 'Contacts', Icon: Users },
  { key: 'files', label: 'Files', Icon: FileText },
  { key: 'quickreplies', label: 'Quick replies', Icon: Zap },
  { key: 'templates', label: 'Templates', Icon: LayoutTemplate },
];

const CRM_URL = 'https://crm.migrizo.com';

export function Rail({
  active,
  onSelect,
  theme,
  onToggleTheme,
  userName,
  unread,
  isMobile,
  onHoverChange,
  hovering,
}: {
  active: RailKey;
  onSelect: (k: RailKey) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  userName: string;
  unread: number;
  isMobile: boolean;
  onHoverChange: (v: boolean) => void;
  hovering: boolean;
}) {
  // Wide while the cursor is over it; icon-only otherwise. On a phone there is
  // no cursor and no room, so it stays icon-only there.
  const wide = hovering && !isMobile;

  const item = (key: RailKey, label: string, Icon: typeof MessageSquare) => {
    const on = active === key;
    return (
      <button
        key={key}
        onClick={() => onSelect(key)}
        title={wide ? undefined : label}
        aria-label={label}
        aria-current={on ? 'page' : undefined}
        style={{
          position: 'relative',
          height: 40,
          margin: wide ? '0 8px' : '0 auto',
          width: wide ? 'auto' : 40,
          alignSelf: wide ? 'stretch' : 'center',
          border: 0,
          borderRadius: 11,
          background: on ? 'var(--rail-on)' : 'transparent',
          color: on ? 'var(--rail-fg-on)' : 'var(--rail-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: 11,
          padding: wide ? '0 12px' : 0,
          cursor: 'pointer',
          transition: 'background .13s ease, color .13s ease',
          flex: 'none',
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ position: 'relative', display: 'flex', flex: 'none' }}>
          <Icon size={18} strokeWidth={1.8} />
          {key === 'chat' && unread > 0 && (
            <span
              style={{
                position: 'absolute', top: -6, right: -8, minWidth: 15, height: 15, padding: '0 4px',
                borderRadius: 99, background: '#16b59f', color: '#04201c', fontSize: 9.5, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--rail)',
              }}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
        {wide && label}
      </button>
    );
  };

  return (
    <nav
      onMouseEnter={() => !isMobile && onHoverChange(true)}
      onMouseLeave={() => !isMobile && onHoverChange(false)}
      style={{
        width: wide ? 196 : 62,
        flex: 'none',
        // While hovered the rail floats OVER the list, so the whole app does
        // not lurch sideways every time the cursor passes.
        position: !isMobile && hovering ? 'absolute' : 'relative',
        zIndex: 25,
        height: '100%',
        boxShadow: !isMobile && hovering ? '4px 0 24px -8px rgba(0,0,0,.45)' : 'none',
        background: 'var(--rail)',
        display: 'flex',
        flexDirection: 'column',
        padding: '14px 0 12px',
        gap: 2,
        transition: 'width .16s ease',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: wide ? '0 14px' : '0', justifyContent: wide ? 'flex-start' : 'center', marginBottom: 14 }}>
        <a
          href={CRM_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Back to Migrizo CRM"
          style={{ width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(140deg,#16b59f,#0a6e62)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19V7a3 3 0 013-3h10a3 3 0 013 3v6a3 3 0 01-3 3H8z" />
          </svg>
        </a>
        {wide && <span style={{ color: 'var(--rail-fg-on)', fontWeight: 800, fontSize: 15, letterSpacing: '-0.01em' }}>Migrizo</span>}
      </div>

      {ITEMS.map(({ key, label, Icon }) => item(key, label, Icon))}

      <div style={{ flex: 1 }} />

      {/* The quiet corner: things you touch once a day, not twenty times. */}
      {item('settings', 'Settings', Settings)}

      <button onClick={onToggleTheme} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} aria-label="Toggle theme" style={railBtn(wide)}>
        {theme === 'dark' ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
        {wide && (theme === 'dark' ? 'Light mode' : 'Dark mode')}
      </button>

      <div
        title={userName}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, marginTop: 6,
          padding: wide ? '0 14px' : 0, justifyContent: wide ? 'flex-start' : 'center',
        }}
      >
        <div
          style={{
            width: 30, height: 30, borderRadius: 99, background: avatarTint(userName), color: '#fff',
            fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
          }}
        >
          {initialsOf(userName)}
        </div>
        {wide && <span style={{ color: 'var(--rail-fg)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userName}</span>}
      </div>
    </nav>
  );
}

function railBtn(wide: boolean): React.CSSProperties {
  return {
    height: 40,
    margin: wide ? '0 8px' : '0 auto',
    width: wide ? 'auto' : 40,
    alignSelf: wide ? 'stretch' : 'center',
    border: 0,
    borderRadius: 11,
    background: 'transparent',
    color: 'var(--rail-fg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 11,
    padding: wide ? '0 12px' : 0,
    cursor: 'pointer',
    flex: 'none',
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}
