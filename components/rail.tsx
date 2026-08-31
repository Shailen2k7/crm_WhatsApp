'use client';

import { MessageSquare, Users, Star, FileText, LayoutTemplate, User, Settings, Moon, Sun, ExternalLink } from 'lucide-react';
import { initialsOf, avatarTint } from '@/lib/phone';

export type RailKey = 'chat' | 'contacts' | 'starred' | 'files' | 'templates' | 'team' | 'settings';

const ITEMS: { key: RailKey; label: string; Icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Conversations', Icon: MessageSquare },
  { key: 'contacts', label: 'Contacts', Icon: Users },
  { key: 'starred', label: 'Starred', Icon: Star },
  { key: 'files', label: 'Files', Icon: FileText },
  { key: 'templates', label: 'Templates', Icon: LayoutTemplate },
  { key: 'team', label: 'Team', Icon: User },
  { key: 'settings', label: 'Settings', Icon: Settings },
];

// The CRM this Relay instance is paired with. Clicking the mark goes back.
const CRM_URL = 'https://crm.migrizo.com';

export function Rail({
  active,
  onSelect,
  theme,
  onToggleTheme,
  userName,
  unread,
}: {
  active: RailKey;
  onSelect: (k: RailKey) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  userName: string;
  unread: number;
}) {
  return (
    <nav
      style={{
        width: 62,
        flex: 'none',
        background: 'var(--rail)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 0 12px',
        gap: 2,
      }}
    >
      <a
        href={CRM_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Back to Migrizo CRM"
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: 'linear-gradient(140deg,#16b59f,#0a6e62)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
          flex: 'none',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19V7a3 3 0 013-3h10a3 3 0 013 3v6a3 3 0 01-3 3H8z" />
        </svg>
      </a>

      {ITEMS.map(({ key, label, Icon }) => {
        const on = active === key;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            title={label}
            aria-label={label}
            aria-current={on ? 'page' : undefined}
            style={{
              position: 'relative',
              width: 40,
              height: 40,
              border: 0,
              borderRadius: 11,
              background: on ? 'var(--rail-on)' : 'transparent',
              color: on ? 'var(--rail-fg-on)' : 'var(--rail-fg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'background .13s ease, color .13s ease',
              flex: 'none',
            }}
          >
            <Icon size={18} strokeWidth={1.8} />
            {key === 'chat' && unread > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 5,
                  right: 4,
                  minWidth: 15,
                  height: 15,
                  padding: '0 4px',
                  borderRadius: 99,
                  background: '#16b59f',
                  color: '#04201c',
                  fontSize: 9.5,
                  fontWeight: 800,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '2px solid var(--rail)',
                }}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <a
        href={CRM_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Open Migrizo CRM"
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          color: 'var(--rail-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <ExternalLink size={17} strokeWidth={1.8} />
      </a>

      <button
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        aria-label="Toggle theme"
        style={{
          width: 40,
          height: 40,
          border: 0,
          borderRadius: 11,
          background: 'transparent',
          color: 'var(--rail-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flex: 'none',
        }}
      >
        {theme === 'dark' ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
      </button>

      <div
        title={userName}
        style={{
          width: 30,
          height: 30,
          borderRadius: 99,
          background: avatarTint(userName),
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 6,
          flex: 'none',
        }}
      >
        {initialsOf(userName)}
      </div>
    </nav>
  );
}
