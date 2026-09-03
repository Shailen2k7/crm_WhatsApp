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
import { useState } from 'react';
import {
  MessageSquare, Users, FileText, Zap, Menu, X, Star, LayoutTemplate,
  Workflow, User, Settings, ExternalLink,
} from 'lucide-react';
import type { RailKey } from './rail';

// The four destinations a thumb reaches all day. Everything else lives one tap
// away behind the ☰ sheet — nothing on the desktop rail is missing on a phone.
const TABS: { key: RailKey; label: string; Icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Chats', Icon: MessageSquare },
  { key: 'contacts', label: 'Contacts', Icon: Users },
  { key: 'files', label: 'Files', Icon: FileText },
  { key: 'quickreplies', label: 'Replies', Icon: Zap },
];

const MENU_ITEMS: { key: RailKey; label: string; Icon: typeof MessageSquare; hint: string }[] = [
  { key: 'starred', label: 'Spotlight', Icon: Star, hint: 'Starred chats' },
  { key: 'templates', label: 'Templates', Icon: LayoutTemplate, hint: 'Approved messages' },
  { key: 'automation', label: 'Automation', Icon: Workflow, hint: 'New lead & follow-ups' },
  { key: 'team', label: 'Team', Icon: User, hint: 'Who is on Migrizo' },
  { key: 'settings', label: 'Settings', Icon: Settings, hint: 'Account & notifications' },
];

const CRM_URL = 'https://crm.migrizo.com';

export function MobileTabs({
  active,
  onSelect,
  unread,
}: {
  active: RailKey;
  onSelect: (k: RailKey) => void;
  unread: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuActive = MENU_ITEMS.some((m) => m.key === active);

  return (
    <>
    {/* ── the ☰ sheet: every remaining destination, one tap away ────────── */}
    {menuOpen && (
      <div
        onClick={() => setMenuOpen(false)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 40, animation: 'fade-in .15s ease' }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="animate-sheet-up"
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            background: 'var(--surface)', borderRadius: '20px 20px 0 0',
            border: '1px solid var(--line)', borderBottom: 'none',
            padding: '10px 16px calc(18px + env(safe-area-inset-bottom))',
            boxShadow: '0 -12px 40px rgba(0,0,0,.25)',
          }}
        >
          {/* grab handle */}
          <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--line)', margin: '2px auto 12px' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>Menu</span>
            <button
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
              style={{ width: 32, height: 32, borderRadius: 10, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {MENU_ITEMS.map(({ key, label, Icon, hint }) => {
              const on = active === key;
              return (
                <button
                  key={key}
                  onClick={() => { setMenuOpen(false); onSelect(key); }}
                  aria-current={on ? 'page' : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                    padding: '13px 14px', borderRadius: 14, cursor: 'pointer',
                    border: '1px solid ' + (on ? 'var(--teal)' : 'var(--line)'),
                    background: on ? 'var(--teal-bg)' : 'var(--bg)',
                  }}
                >
                  <span style={{
                    width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', flex: 'none',
                    background: on ? 'var(--teal)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--teal)',
                  }}>
                    <Icon size={18} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{label}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</span>
                  </span>
                </button>
              );
            })}

            {/* Jump back to the main CRM, same as the rail's shortcut. */}
            <a
              href={CRM_URL}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none',
                padding: '13px 14px', borderRadius: 14, border: '1px solid var(--line)', background: 'var(--bg)',
              }}
            >
              <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-2)', color: 'var(--teal)' }}>
                <ExternalLink size={18} />
              </span>
              <span>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Open CRM</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>crm.migrizo.com</span>
              </span>
            </a>
          </div>
        </div>
      </div>
    )}

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

      {/* ── ☰ More — everything else ──────────────────────────────────────── */}
      <button
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="More options"
        aria-expanded={menuOpen}
        style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 3, padding: '9px 0 7px', border: 0, background: 'transparent',
          color: menuActive || menuOpen ? 'var(--teal)' : 'var(--muted)', cursor: 'pointer', minHeight: 54,
        }}
      >
        <Menu size={21} strokeWidth={menuActive || menuOpen ? 2.2 : 1.7} />
        <span style={{ fontSize: 10.5, fontWeight: menuActive || menuOpen ? 700 : 500, letterSpacing: '.01em' }}>Menu</span>
      </button>
    </nav>
    </>
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
