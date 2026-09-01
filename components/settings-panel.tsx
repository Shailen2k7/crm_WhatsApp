'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { LogOut, Moon, Sun, RefreshCw } from 'lucide-react';
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
  const [log, setLog] = useState<WebhookLogRow[] | null>(null);
  const [interakt, setInterakt] = useState<InteraktState | null>(null);
  const [testing, setTesting] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  const supabaseRef = useMemo(() => createClient(), []);

  // Every call Interakt makes — accepted or rejected — so "did the provider
  // even reach us?" is answerable here instead of in hosting logs.
  const loadLog = useMemo(
    () => async () => {
      const { data, error } = await supabaseRef
        .from('relay_webhook_log')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(15);
      if (error) { setLogErr(error.message); setLog([]); return; }
      setLogErr(null);
      setLog((data || []) as WebhookLogRow[]);
    },
    [supabaseRef]
  );

  useEffect(() => { loadLog(); }, [loadLog]);

  // Proves the API key works without messaging anybody — see the route.
  async function testInterakt() {
    setTesting(true);
    try {
      const r = await fetch('/api/whatsapp/test-connection');
      setInterakt(await r.json());
    } catch {
      setInterakt({ ok: false, state: 'unreachable', detail: 'Could not run the test.' });
    } finally {
      setTesting(false);
    }
  }
  useEffect(() => { testInterakt(); }, []);

  async function signOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace('https://', '').split('.')[0];
  const wabaNumber = process.env.NEXT_PUBLIC_WABA_NUMBER || '';

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '32px 24px 60px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 26px' }}>Relay · Phase 2</p>

        <Card title="Connection">
          <Row label="Database" value={<Status ok={true} text="Connected" />} />
          <Row label="Live updates" value={<Status ok={live} text={live ? 'Subscribed' : 'Connecting…'} />} />
          <Row label="Supabase project" value={<Mono>{projectRef || 'not set'}</Mono>} />
          <Row label="Leads loaded" value={<strong>{leadCount.toLocaleString('en-IN')}</strong>} />
          <Row
            label="WhatsApp number"
            value={wabaNumber ? <strong>{wabaNumber}</strong> : <span style={{ color: 'var(--muted)' }}>set NEXT_PUBLIC_WABA_NUMBER</span>}
          />
          <Row
            label="Interakt API"
            value={
              interakt
                ? <Status ok={!!interakt.ok} text={interakt.ok ? 'Connected' : interakt.state === 'unauthorized' ? 'Bad API key' : interakt.state} />
                : <Status ok={false} text={testing ? 'Testing…' : '—'} />
            }
          />
          <Row
            label="Webhook URL"
            value={<Mono>chat.migrizo.com/api/whatsapp/webhook</Mono>}
          />
          {interakt && !interakt.ok && (
            <div style={{ fontSize: 11.5, color: 'var(--amber)', lineHeight: 1.5, paddingTop: 6 }}>
              {interakt.detail}
            </div>
          )}
          <div style={{ paddingTop: 9 }}>
            <button
              onClick={testInterakt}
              disabled={testing}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              <RefreshCw size={12} /> {testing ? 'Testing…' : 'Test Interakt connection'}
            </button>
          </div>
        </Card>

        <Card title="Webhook activity">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Every call Interakt makes to Relay, newest first.
            </span>
            <button
              onClick={loadLog}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {logErr && (
            <div style={{ fontSize: 12, color: 'var(--amber)', lineHeight: 1.55, padding: '8px 0' }}>
              Could not read the log ({logErr}). Run migration <code>101_relay_webhook_log.sql</code> in Supabase.
            </div>
          )}

          {log && log.length === 0 && !logErr && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, padding: '10px 0' }}>
              <strong style={{ color: 'var(--ink-2)' }}>Interakt has never called this endpoint.</strong>
              <br />
              Not a signature problem — nothing is arriving at all. Check that the webhook URL is
              saved in Interakt, that incoming-message events are switched on, and that your
              Interakt plan includes webhooks (Growth or Advanced — Starter does not).
            </div>
          )}

          {log && log.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '7px 0', borderTop: '1px solid var(--line-2)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: r.ok ? 'var(--teal)' : 'var(--red)', marginTop: 5, flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)' }}>
                  {r.event_type || r.reason}
                  {r.phone && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {r.phone}</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {new Date(r.received_at).toLocaleString('en-IN')} · {r.ok ? (r.handled || r.reason) : r.reason}
                  {!r.sig_present && ' · no signature header'}
                </div>
              </div>
            </div>
          ))}
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

interface InteraktState {
  ok: boolean;
  state: string;
  detail?: string;
  httpStatus?: number;
}

interface WebhookLogRow {
  id: string;
  received_at: string;
  ok: boolean;
  reason: string;
  event_type: string | null;
  sig_present: boolean;
  phone: string | null;
  handled: string | null;
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
