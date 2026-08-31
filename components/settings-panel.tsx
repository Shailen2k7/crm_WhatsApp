'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { LogOut, Moon, Sun } from 'lucide-react';
import type { RelayUser, Workspace } from '@/lib/types';

/**
 * Phase 1 settings double as a diagnostics page: whether the shared database is
 * actually live, how many leads came through, which project we are pointed at.
 * That is what you want visible while testing, so it is here on purpose.
 */
export function SettingsPanel({
  user,
  workspace,
  role,
  leadCount,
  live,
  theme,
  onToggleTheme,
}: {
  user: RelayUser;
  workspace: Workspace;
  role: 'admin' | 'member';
  leadCount: number;
  live: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace('https://', '').split('.')[0];

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '32px 24px 60px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 26px' }}>Relay · Phase 1</p>

        <Card title="Connection">
          <Row label="Database" value={<Status ok={true} text="Connected" />} />
          <Row label="Live updates" value={<Status ok={live} text={live ? 'Subscribed' : 'Connecting…'} />} />
          <Row label="Supabase project" value={<Mono>{projectRef || 'not set'}</Mono>} />
          <Row label="Leads loaded" value={<strong>{leadCount.toLocaleString('en-IN')}</strong>} />
          <Row label="WhatsApp (Interakt)" value={<Status ok={false} text="Phase 2" />} />
        </Card>

        <Card title="Account">
          <Row label="Signed in as" value={user.email} />
          <Row label="Name" value={user.name} />
          <Row label="Workspace" value={workspace.name} />
          <Row label="Role" value={role === 'admin' ? 'Admin' : 'Member'} />
        </Card>

        <Card title="Appearance">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Theme</span>
            <button
              onClick={onToggleTheme}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '7px 13px',
                borderRadius: 9,
                border: '1px solid var(--line)',
                background: 'var(--surface-2)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </Card>

        <button
          onClick={signOut}
          disabled={signingOut}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 17px',
            borderRadius: 9,
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: 'var(--red)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            marginTop: 8,
          }}
        >
          <LogOut size={15} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 13,
        padding: '16px 18px',
        marginBottom: 16,
        boxShadow: 'var(--shadow)',
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 9 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderTop: '1px solid var(--line-2)' }}>
      <span style={{ fontSize: 13, color: 'var(--muted)', flex: 'none' }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--ink-2)', textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

function Status({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 99,
          background: ok ? 'var(--teal)' : 'var(--amber)',
          animation: ok ? undefined : 'pulseDot 1.6s ease-in-out infinite',
        }}
      />
      {text}
    </span>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{children}</code>;
}
