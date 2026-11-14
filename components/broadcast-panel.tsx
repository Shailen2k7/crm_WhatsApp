'use client';

// =============================================================================
// BROADCASTS — one message, by hand, to a group you pick.
// -----------------------------------------------------------------------------
// Three screens behind one menu item:
//   the list      every broadcast so far, and "New broadcast"
//   the composer  who · what · when, with a live count and a phone preview
//   the results   sent / delivered / read / replied / failed, person by person
//
// This is NOT an automation. Nothing here starts on its own or repeats: a
// broadcast goes once, to the people chosen, when an admin confirms it.
// =============================================================================
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Loader2, Megaphone, Plus } from 'lucide-react';
import type { BroadcastDetail, BroadcastSummary } from '@/lib/broadcast/model';
import { BroadcastCompose, type ComposeSeed } from './broadcast-compose';
import { BroadcastDetailView } from './broadcast-detail';
import { Btn, Note, StatusPill, api, fmtWhen, num } from './broadcast-ui';

type Screen = { at: 'list' } | { at: 'compose'; seed: ComposeSeed | null; key: number } | { at: 'detail'; id: string };

export function BroadcastPanel({
  isMobile, isAdmin, onOpenChat,
}: {
  isMobile: boolean;
  isAdmin: boolean;
  onOpenChat: (leadId: string) => void;
}) {
  const [screen, setScreen] = useState<Screen>({ at: 'list' });
  const [items, setItems] = useState<BroadcastSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    const j = await api<{ broadcasts: BroadcastSummary[] }>('/api/broadcast');
    if (!j.ok) { setError(j.error || 'Could not load broadcasts.'); setItems((v) => v || []); return; }
    setError(null); setItems(j.broadcasts);
  }, []);

  useEffect(() => { if (isAdmin && screen.at === 'list') void load(); }, [isAdmin, screen.at, load]);
  // Anything on the move keeps the list's numbers fresh while it is on screen.
  const anyLive = !!items?.some((b) => b.status === 'sending' || b.status === 'scheduled');
  useEffect(() => {
    if (!isAdmin || screen.at !== 'list' || !anyLive) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 8000);
    return () => clearInterval(t);
  }, [isAdmin, screen.at, anyLive, load]);

  if (!isAdmin) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
        <div style={{ maxWidth: 380, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6 }}>
          <Megaphone size={26} style={{ color: 'var(--teal)', display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontWeight: 750, color: 'var(--ink)', fontSize: 15, marginBottom: 4 }}>Broadcasts are for admins</div>
          Sending one message to many people costs money and reaches customers, so only an admin can do it.
        </div>
      </div>
    );
  }

  /** A draft opens in the composer; everything else opens its results. */
  async function open(b: BroadcastSummary) {
    if (b.status !== 'draft') { setScreen({ at: 'detail', id: b.id }); return; }
    setOpening(b.id);
    const j = await api<{ broadcast: BroadcastDetail }>(`/api/broadcast/detail?id=${encodeURIComponent(b.id)}`);
    setOpening(null);
    if (!j.ok) { setError(j.error || 'Could not open that draft.'); return; }
    const d = j.broadcast;
    setScreen({
      at: 'compose', key: Date.now(),
      seed: { id: d.id, name: d.name, spec: d.spec, templateName: d.templateName, language: d.templateLanguage, variables: d.variables, rate: d.rate, quietHours: d.quietHours },
    });
  }

  if (screen.at === 'compose') {
    return (
      <BroadcastCompose
        key={screen.key} seed={screen.seed} isMobile={isMobile}
        onBack={() => setScreen({ at: 'list' })}
        onLaunched={(id) => setScreen({ at: 'detail', id })}
        onSavedDraft={() => { void load(); }}
      />
    );
  }
  if (screen.at === 'detail') {
    return (
      <BroadcastDetailView
        key={screen.id} id={screen.id} isMobile={isMobile}
        onBack={() => setScreen({ at: 'list' })}
        onOpenChat={onOpenChat}
        onDeleted={() => setScreen({ at: 'list' })}
        onDuplicate={(d) => setScreen({
          at: 'compose', key: Date.now(),
          // No id: a duplicate is a brand-new broadcast. Hand-removed people start afresh too.
          seed: { name: `${d.name} (copy)`, spec: { ...d.spec, removed: [] }, templateName: d.templateName, language: d.templateLanguage, variables: d.variables, rate: d.rate, quietHours: d.quietHours },
        })}
      />
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px' : '18px 22px', borderBottom: '1px solid var(--line)', background: 'var(--surface)', flex: 'none' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-.01em' }}>Broadcasts</h1>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>Send one message to a group you pick — all Hot leads, all Spotlight, anyone you choose.</div>
        </div>
        <Btn kind="primary" onClick={() => setScreen({ at: 'compose', seed: null, key: Date.now() })}><Plus size={15} /> New broadcast</Btn>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? 12 : 22 }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 }}>
          {error && <Note tone="error">{error}</Note>}
          {!items && !error && (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}><Loader2 size={22} style={{ animation: 'spin .8s linear infinite', color: 'var(--muted)' }} /></div>
          )}
          {items && !items.length && !error && (
            <div style={{ background: 'var(--surface)', border: '1px dashed var(--line)', borderRadius: 16, padding: '38px 24px', textAlign: 'center' }}>
              <Megaphone size={28} style={{ color: 'var(--teal)', display: 'block', margin: '0 auto' }} />
              <div style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--ink)', margin: '10px 0 4px' }}>No broadcasts yet</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 420, margin: '0 auto 16px' }}>
                Got an offer or an announcement? Pick who should get it, choose an approved template, check the preview, and send — now or at a time you set.
              </div>
              <Btn kind="primary" onClick={() => setScreen({ at: 'compose', seed: null, key: Date.now() })}><Plus size={15} /> New broadcast</Btn>
            </div>
          )}
          {(items || []).map((b) => {
            const done = b.total - b.waiting;
            const pct = b.total ? Math.round((done / b.total) * 100) : 0;
            return (
              <button
                key={b.id} type="button" onClick={() => void open(b)}
                style={{ textAlign: 'left', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: '14px 16px', cursor: 'pointer', fontFamily: 'inherit', boxShadow: 'var(--shadow-sm)', display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0,1fr)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14.5, fontWeight: 750, color: 'var(--ink)' }}>{b.name}</span>
                  <StatusPill status={b.status} />
                  {opening === b.id && <Loader2 size={14} style={{ animation: 'spin .8s linear infinite', color: 'var(--muted)' }} />}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
                    {b.status === 'scheduled' ? <><CalendarClock size={12} style={{ display: 'inline-block', verticalAlign: -2, marginRight: 4 }} />{fmtWhen(b.scheduledAt)}</> : fmtWhen(b.startedAt || b.createdAt)}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {b.audienceLabel || 'Nobody picked yet'}{b.templateName ? ` · template ${b.templateName}` : ''}
                </div>
                {b.status === 'paused' && b.pausedReason && <div style={{ fontSize: 12, color: 'var(--amber)', fontWeight: 600 }}>Paused itself — open to see why.</div>}
                {b.status !== 'draft' && (
                  <>
                    <div style={{ height: 5, borderRadius: 99, background: 'var(--surface-3)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: b.status === 'cancelled' ? 'var(--muted)' : 'var(--teal)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
                      <span><b>{num(b.total)}</b> people</span>
                      <span><b>{num(b.sent)}</b> sent</span>
                      {b.waiting > 0 && <span><b>{num(b.waiting)}</b> waiting</span>}
                      {b.failed > 0 && <span style={{ color: 'var(--red)' }}><b>{num(b.failed)}</b> failed</span>}
                      {b.skipped > 0 && <span style={{ color: 'var(--amber)' }}><b>{num(b.skipped)}</b> skipped</span>}
                    </div>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
