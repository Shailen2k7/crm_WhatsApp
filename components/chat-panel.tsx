'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Search, Star, PanelRight, Paperclip, Send, MessageSquare, ArrowLeft,
  AlertCircle, Loader2, RotateCw, Lock, FileText, Download, X, Trash2,
  MoreHorizontal, Zap, Image as ImageIcon, Copy, ArrowLeftRight,
} from 'lucide-react';
import { initialsOf, avatarTint, formatPhone } from '@/lib/phone';
import type { Contact } from '@/lib/contacts';
import { windowState, formatWindow } from '@/lib/interakt';
import type { RelayMessage, QuickReply } from '@/lib/messages';

interface PendingFile { path: string; name: string; mime: string; size: number }

function fmtBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatPanel({
  contact,
  workspaceId,
  role,
  crmOpen,
  onToggleCrm,
  onBack,
  onDeleted,
  isMobile,
}: {
  contact: Contact | null;
  workspaceId: string;
  role: 'admin' | 'member';
  crmOpen: boolean;
  onToggleCrm: () => void;
  onBack: () => void;
  onDeleted: () => void;
  isMobile: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lastInboundAt, setLastInboundAt] = useState<string | null>(null);
  const [spotlight, setSpotlight] = useState(false);
  const [messages, setMessages] = useState<RelayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [qrOpen, setQrOpen] = useState(false);
  const [, setTick] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const contactKey = contact?.key ?? null;
  const phoneE164 = contact?.phoneE164 ?? null;
  const displayName = contact ? (contact.unknown ? formatPhone(contact.phoneE164) : contact.name) : '';
  const firstName = contact && !contact.unknown ? contact.name.split(' ')[0] : 'them';
  const avatarSeed = contact?.key ?? '';

  // ---- conversation + history ---------------------------------------------
  useEffect(() => {
    if (!contactKey || !phoneE164) {
      setConversationId(null); setMessages([]); setLastInboundAt(null); setSpotlight(false);
      return;
    }
    let cancelled = false;
    lastCountRef.current = 0;
    setLoading(true); setError(null); setDraft(''); setPending([]); setInternal(false);

    (async () => {
      const { data: conv } = await supabase
        .from('relay_conversations')
        .select('id, last_inbound_at, spotlight')
        .eq('workspace_id', workspaceId)
        .eq('phone_e164', phoneE164)
        .maybeSingle();

      if (cancelled) return;
      if (!conv) {
        setConversationId(null); setLastInboundAt(null); setSpotlight(false); setMessages([]); setLoading(false);
        return;
      }
      setConversationId(conv.id);
      setLastInboundAt(conv.last_inbound_at);
      setSpotlight(!!conv.spotlight);

      const { data: msgs } = await supabase
        .from('relay_messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(500);

      if (cancelled) return;
      setMessages((msgs || []) as RelayMessage[]);
      setLoading(false);
    })();

    return () => { cancelled = true; };
    // Keyed on PRIMITIVES, never on the contact object: its identity changes on
    // every parent render, which used to reload the thread continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, contactKey, phoneE164, workspaceId]);

  // ---- realtime ------------------------------------------------------------
  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase
      .channel('relay-msgs-' + conversationId)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'relay_messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const gone = (payload.old as { id?: string })?.id;
            if (gone) setMessages((prev) => prev.filter((m) => m.id !== gone));
            return;
          }
          const row = payload.new as RelayMessage;
          if (!row?.id) return;
          setMessages((prev) => {
            const i = prev.findIndex((m) => m.id === row.id);
            if (i === -1) return [...prev, row];
            const copy = [...prev];
            copy[i] = row;
            return copy;
          });
          if (row.direction === 'in') setLastInboundAt(row.created_at);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, conversationId]);

  // ---- quick replies -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('relay_quick_replies')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('sort_order')
        .order('title');
      if (!cancelled && data) setQuickReplies(data as QuickReply[]);
    })();
    return () => { cancelled = true; };
  }, [supabase, workspaceId]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Jump to the bottom when the thread CHANGES or GROWS — never on a re-render
  // caused by a status tick, which used to yank the view around mid-read.
  const lastCountRef = useRef(0);
  useEffect(() => {
    if (messages.length === lastCountRef.current) return;
    const grew = messages.length > lastCountRef.current;
    lastCountRef.current = messages.length;
    bottomRef.current?.scrollIntoView({ behavior: grew && messages.length < 40 ? 'smooth' : 'auto' });
  }, [messages.length]);

  // "/" at the start of an empty composer opens quick replies — muscle memory
  // from every serious support tool.
  useEffect(() => {
    setQrOpen(draft === '/' || (draft.startsWith('/') && draft.length <= 20 && !draft.includes(' ')));
  }, [draft]);

  const win = windowState(lastInboundAt);
  // Internal notes bypass the window entirely — they never reach WhatsApp.
  const canType = win.open || internal;
  const canSend = (draft.trim().length > 0 || pending.length > 0) && !sending && !uploading && (internal ? draft.trim().length > 0 : canType);

  // ---- attach --------------------------------------------------------------
  async function attachFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true); setError(null);
    for (const f of Array.from(files).slice(0, 10 - pending.length)) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        const res = await fetch('/api/whatsapp/upload', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.ok) setPending((prev) => [...prev, json.attachment]);
        else setError(json.error || `Could not upload ${f.name}`);
      } catch {
        setError(`Could not upload ${f.name}`);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  // ---- send ----------------------------------------------------------------
  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && pending.length === 0) || !contact || sending) return;
    setSending(true); setError(null);

    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: contact.phoneRaw,
          conversationId: conversationId || undefined,
          message: text,
          internal,
          attachments: internal ? [] : pending,
        }),
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setError(json.error || 'Could not send.');
        setSending(false);
        return; // draft and files kept — never throw away what someone typed
      }

      setDraft(''); setPending([]); setInternal(false);
      if (!conversationId && json.conversationId) setConversationId(json.conversationId);
      if (json.partialFailures > 0) setError(`${json.partialFailures} file(s) failed to send — they stay in the thread marked failed.`);
      if (json.conversationId) {
        const { data } = await supabase
          .from('relay_messages')
          .select('*')
          .eq('conversation_id', json.conversationId)
          .order('created_at', { ascending: true })
          .limit(500);
        if (data) setMessages(data as RelayMessage[]);
      }
    } catch {
      setError('Network error — nothing was sent.');
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }, [draft, pending, internal, contact, sending, conversationId, supabase]);

  // ---- quick reply insert --------------------------------------------------
  function applyQuickReply(q: QuickReply) {
    setDraft(q.body);
    if (q.attachments?.length) setPending((prev) => [...prev, ...q.attachments].slice(0, 10));
    setQrOpen(false);
    taRef.current?.focus();
  }

  // ---- spotlight + delete --------------------------------------------------
  async function toggleSpotlight() {
    if (!conversationId) return;
    const next = !spotlight;
    setSpotlight(next);
    await supabase.from('relay_conversations').update({ spotlight: next }).eq('id', conversationId);
  }

  async function deleteConversation() {
    if (!conversationId) return;
    if (!confirm(`Delete this entire chat with ${displayName}?\n\nEvery message and every file in it is removed permanently. The CRM lead is not touched.`)) return;
    const res = await fetch(`/api/whatsapp/conversation/${conversationId}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.ok) onDeleted();
    else setError(json.error || 'Could not delete.');
    setMenuOpen(false);
  }

  /**
   * Moves one message to the other side of the thread.
   *
   * Needed because messages stored BEFORE the direction fix are frozen on the
   * wrong side — new code cannot retro-correct rows whose origin was never
   * recorded. Rather than guess in a migration, the person who can actually see
   * whose message it was gets a one-tap fix.
   */
  async function flipSide(m: RelayMessage) {
    const next = m.direction === 'in' ? 'out' : 'in';
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, direction: next } : x)));
    const { error: err } = await supabase
      .from('relay_messages')
      .update({ direction: next, status: next === 'out' ? 'delivered' : 'received' })
      .eq('id', m.id);
    if (err) setError(err.message);
  }

  async function deleteMessage(id: string) {
    if (!conversationId) return;
    if (!confirm('Delete this message (and its file, if any) permanently?')) return;
    const res = await fetch(`/api/whatsapp/conversation/${conversationId}?messageId=${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.ok) setError(json.error || 'Could not delete.');
  }

  if (!contact) return <EmptyState />;

  const qrMatches = qrOpen
    ? quickReplies.filter((q) => draft.length <= 1 || q.shortcut.toLowerCase().startsWith(draft.slice(1).toLowerCase()))
    : [];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--chat)' }}>
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 14px', paddingTop: 'calc(10px + env(safe-area-inset-top))', background: 'var(--surface)', borderBottom: '1px solid var(--line)', flex: 'none' }}>
        {isMobile && (
          <button onClick={onBack} aria-label="Back" style={iconBtn}><ArrowLeft size={19} /></button>
        )}
        <div style={{ width: 38, height: 38, borderRadius: 99, background: contact.unknown ? 'var(--surface-3)' : avatarTint(avatarSeed), color: contact.unknown ? 'var(--muted)' : '#fff', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          {contact.unknown ? '?' : initialsOf(contact.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
            {contact.unknown ? (
              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--amber-bg)', color: 'var(--amber)', flex: 'none' }}>Not in CRM</span>
            ) : (
              !isMobile && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--teal-bg)', color: 'var(--teal-ink)', flex: 'none' }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  CRM linked
                </span>
              )
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{formatPhone(contact.phoneE164)}</div>
        </div>

        {!isMobile && <button aria-label="Search in conversation" style={iconBtn}><Search size={17} /></button>}
        <button
          onClick={toggleSpotlight}
          aria-label={spotlight ? 'Remove spotlight' : 'Spotlight this chat'}
          title={conversationId ? 'Spotlight' : 'Spotlight is available once the chat has messages'}
          disabled={!conversationId}
          style={{ ...iconBtn, color: spotlight ? 'var(--amber)' : 'var(--muted)', opacity: conversationId ? 1 : 0.4 }}
        >
          <Star size={17} fill={spotlight ? 'var(--amber)' : 'none'} />
        </button>
        <button onClick={onToggleCrm} aria-label="Toggle CRM panel" style={{ ...iconBtn, background: crmOpen ? 'var(--surface-3)' : 'transparent', color: crmOpen ? 'var(--teal-ink)' : 'var(--muted)' }}>
          <PanelRight size={17} />
        </button>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setMenuOpen((v) => !v)} aria-label="More" style={iconBtn}><MoreHorizontal size={17} /></button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
              <div className="animate-pop-in" style={{ position: 'absolute', right: 0, top: 38, zIndex: 31, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 11, boxShadow: 'var(--shadow)', minWidth: 200, overflow: 'hidden' }}>
                {role === 'admin' ? (
                  <button
                    onClick={deleteConversation}
                    disabled={!conversationId}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '11px 14px', border: 0, background: 'transparent', color: 'var(--red)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: conversationId ? 1 : 0.4 }}
                  >
                    <Trash2 size={15} /> Delete entire chat
                  </button>
                ) : (
                  <div style={{ padding: '11px 14px', fontSize: 12, color: 'var(--muted)' }}>Only an admin can delete chats.</div>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      {/* Thread */}
      {/* Breathing room at both edges. clamp() keeps it proportional on a wide
          desktop without stealing half the screen on a phone, where every pixel
          of message width counts. */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          minHeight: 0,
          padding: '16px 0 6px',
          paddingInline: 'clamp(12px, 7%, 110px)',
        }}
      >
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24, color: 'var(--muted)' }}>
            <Loader2 size={18} style={{ animation: 'spin .8s linear infinite' }} />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center' }}>
            <div style={{ maxWidth: 340 }}>
              <div style={{ width: 50, height: 50, borderRadius: 15, background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 13px', color: 'var(--muted)' }}>
                <MessageSquare size={22} strokeWidth={1.6} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>No messages yet</div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
                {win.open
                  ? `Send the first message to ${firstName}.`
                  : `${firstName === 'them' ? 'They have' : firstName + ' has'} not messaged you, so WhatsApp only allows an approved template to start this conversation.`}
              </p>
            </div>
          </div>
        )}

        {!loading &&
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const showDate = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
            return (
              <div key={m.id}>
                {showDate && <DateSeparator iso={m.created_at} />}
                <Bubble message={m} isAdmin={role === 'admin'} onDelete={() => deleteMessage(m.id)} onFlip={() => flipSide(m)} />
              </div>
            );
          })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div
        style={{
          padding: '8px 12px',
          // Only the home-indicator inset sits below the composer — nothing else,
          // so it rests on the bottom edge the way every messaging app does.
          paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
          flex: 'none',
          position: 'relative',
          background: 'var(--chat)',
        }}
      >
        {/* Quick replies popover */}
        {qrOpen && qrMatches.length > 0 && (
          <div className="animate-pop-in" style={{ position: 'absolute', left: 12, right: 12, bottom: '100%', marginBottom: 6, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, boxShadow: 'var(--shadow)', maxHeight: 280, overflowY: 'auto', zIndex: 20 }}>
            <div style={{ padding: '9px 14px 5px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>Quick replies</div>
            {qrMatches.map((q) => (
              <button key={q.id} onClick={() => applyQuickReply(q)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', border: 0, borderTop: '1px solid var(--line-2)', background: 'transparent', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--teal-ink)' }}>/{q.shortcut}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{q.title}</span>
                  {q.attachments?.length > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: 'var(--muted)' }}>
                      <Paperclip size={11} /> {q.attachments.length}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.body}</div>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="animate-fade-in" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: 'var(--red-bg)', color: 'var(--red)', padding: '9px 12px', borderRadius: 10, fontSize: 12.3, fontWeight: 500, marginBottom: 8, lineHeight: 1.5 }}>
            <AlertCircle size={14} style={{ flex: 'none', marginTop: 1 }} />
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontWeight: 700, flex: 'none' }}>×</button>
          </div>
        )}

        {!win.open && !internal && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--amber-bg)', color: 'var(--ink-2)', padding: '9px 12px', borderRadius: 10, fontSize: 12.3, marginBottom: 8, lineHeight: 1.5 }}>
            <AlertCircle size={14} style={{ flex: 'none', color: 'var(--amber)' }} />
            <span><strong>24-hour window closed.</strong> Only an approved template can reach {firstName} — or switch to an internal note (🔒).</span>
          </div>
        )}

        {/* Pending attachments */}
        {pending.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {pending.map((f, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 9px', borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 11.5, fontWeight: 600 }}>
                <FileText size={12} style={{ color: 'var(--teal)' }} />
                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{fmtBytes(f.size)}</span>
                <button onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove" style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 0 }}>
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          style={{
            background: internal ? 'var(--amber-bg)' : 'var(--surface)',
            border: internal ? '1px solid var(--amber)' : '1px solid var(--line)',
            borderRadius: 14,
            boxShadow: 'var(--shadow)',
            transition: 'background .15s ease, border-color .15s ease',
          }}
        >
          {internal && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px 0', fontSize: 11, fontWeight: 700, color: 'var(--amber)' }}>
              <Lock size={11} /> INTERNAL NOTE — the client never sees this
            </div>
          )}
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              if (e.key === 'Escape') setQrOpen(false);
            }}
            disabled={(!canType && !internal) || sending}
            rows={1}
            placeholder={
              internal
                ? 'Note for the team — never sent to the client'
                : canType
                ? `Message ${firstName}…   ⏎ send · / quick replies`
                : 'Window closed — template required, or write an internal note'
            }
            style={{
              width: '100%', border: 0, outline: 0, resize: 'none', background: 'transparent',
              padding: '13px 16px 4px', fontSize: 15, lineHeight: 1.5, maxHeight: 140, minHeight: 48,
              cursor: canType || internal ? 'text' : 'not-allowed',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px 9px' }}>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => attachFiles(e.target.files)} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.rtf" />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={internal || uploading || !win.open}
              title={internal ? 'Notes cannot carry files (yet)' : win.open ? 'Attach files' : 'Window closed'}
              aria-label="Attach files"
              style={{ ...composerBtn, opacity: internal || !win.open ? 0.35 : 1 }}
            >
              {uploading ? <Loader2 size={17} style={{ animation: 'spin .8s linear infinite' }} /> : <Paperclip size={17} />}
            </button>
            <button
              onClick={() => { setDraft((d) => (d.startsWith('/') ? d : '/')); taRef.current?.focus(); }}
              title="Quick replies ( / )"
              aria-label="Quick replies"
              style={composerBtn}
            >
              <Zap size={17} />
            </button>
            <button
              onClick={() => setInternal((v) => !v)}
              title={internal ? 'Back to WhatsApp message' : 'Internal note — team only'}
              aria-label="Toggle internal note"
              style={{ ...composerBtn, background: internal ? 'var(--amber)' : 'transparent', color: internal ? '#fff' : 'var(--muted)' }}
            >
              <Lock size={16} />
            </button>

            <div style={{ flex: 1 }} />
            {!internal && (
              <span style={{ fontSize: 11, color: win.open ? 'var(--muted)' : 'var(--amber)', marginRight: 8, fontWeight: win.open ? 400 : 600, whiteSpace: 'nowrap' }}>
                24h · {formatWindow(win.msLeft)}
              </span>
            )}
            <button
              onClick={send}
              disabled={!canSend}
              aria-label="Send"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', borderRadius: 10, border: 0,
                background: canSend ? (internal ? 'var(--amber)' : 'var(--teal)') : 'var(--surface-3)',
                color: canSend ? '#fff' : 'var(--muted)',
                fontSize: 13, fontWeight: 700, cursor: canSend ? 'pointer' : 'not-allowed',
              }}
            >
              {sending ? <Loader2 size={13} style={{ animation: 'spin .8s linear infinite' }} /> : internal ? <Lock size={13} /> : <Send size={13} />}
              {sending ? 'Sending' : internal ? 'Save note' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- pieces ------------------------------------------------------------------

function DateSeparator({ iso }: { iso: string }) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  let label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (d.toDateString() === today.toDateString()) label = 'Today';
  else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
  return (
    <div style={{ textAlign: 'center', margin: '14px 0 10px' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</span>
    </div>
  );
}

function Bubble({ message: m, isAdmin, onDelete, onFlip }: { message: RelayMessage; isAdmin: boolean; onDelete: () => void; onFlip: () => void }) {
  const out = m.direction === 'out';
  const failed = m.status === 'failed';
  const internal = m.is_internal;
  const hasFile = !!(m.media_path || m.media_url);
  const isImage = m.media_type === 'image';
  // A menu, not a hover state: hover does not exist on a phone, and 80% of use
  // is on a phone. Tap the ⋯ (or long-press the bubble) to get actions.
  const [menu, setMenu] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startPress = () => {
    pressTimer.current = setTimeout(() => setMenu(true), 500);
  };
  const endPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  return (
    <div
      className="animate-msg-in"
      style={{
        display: 'flex',
        // `row-reverse` REVERSES the main axis, so `flex-end` on an outbound row
        // packed our own messages to the LEFT — the exact opposite of WhatsApp.
        // With the axis flipped, `flex-start` IS the right-hand edge. One value
        // therefore aligns both sides correctly: inbound hard left, outbound
        // hard right.
        justifyContent: 'flex-start',
        flexDirection: out ? 'row-reverse' : 'row',
        width: '100%',
        marginBottom: 7,
        gap: 4,
        alignItems: 'center',
        position: 'relative',
      }}
    >
      <div
        style={{ maxWidth: 'min(78%, 480px)', minWidth: 90 }}
        onTouchStart={startPress}
        onTouchEnd={endPress}
        onTouchMove={endPress}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
      >
        <div
          style={{
            background: internal ? 'var(--amber-bg)' : failed ? 'var(--red-bg)' : out ? 'var(--out-bg)' : 'var(--in-bg)',
            color: internal ? 'var(--ink)' : failed ? 'var(--ink)' : out ? 'var(--out-fg)' : 'var(--in-fg)',
            border: internal ? '1px dashed var(--amber)' : out || failed ? 'none' : '1px solid var(--line-2)',
            borderRadius: out ? '14px 14px 5px 14px' : '14px 14px 14px 5px',
            padding: hasFile && isImage ? 5 : '9px 13px 7px',
            boxShadow: 'var(--shadow)',
            overflow: 'hidden',
          }}
        >
          {internal && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 800, color: 'var(--amber)', margin: hasFile && isImage ? '5px 9px 3px' : '0 0 4px', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <Lock size={10} /> Internal
            </div>
          )}
          {m.template_name && (
            <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.75, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Template · {m.template_name}
            </div>
          )}

          {/* Image: inline preview, tap to open full-size. */}
          {hasFile && isImage && (
            <a href={`/api/whatsapp/media/${m.id}`} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/whatsapp/media/${m.id}`}
                alt={m.media_name || 'photo'}
                style={{ display: 'block', width: '100%', maxHeight: 340, objectFit: 'cover', borderRadius: 10 }}
                loading="lazy"
              />
            </a>
          )}

          {/* Document / audio / video: a card with the real filename + download. */}
          {hasFile && !isImage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px', minWidth: 200 }}>
              <div style={{ width: 38, height: 38, borderRadius: 9, background: out ? 'rgba(255,255,255,.16)' : 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                {m.media_type === 'audio' || m.media_type === 'video' ? <ImageIcon size={17} /> : <FileText size={17} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.8, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.media_name || 'Attachment'}
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.75 }}>
                  {(m.media_name || '').split('.').pop()?.toUpperCase() || m.media_type?.toUpperCase()} {m.media_size ? '· ' + fmtBytes(m.media_size) : ''}
                </div>
              </div>
              <a
                href={`/api/whatsapp/media/${m.id}?download`}
                aria-label="Download"
                style={{ width: 32, height: 32, borderRadius: 99, background: out ? 'rgba(255,255,255,.2)' : 'var(--teal-bg)', color: out ? '#fff' : 'var(--teal-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}
              >
                <Download size={15} />
              </a>
            </div>
          )}

          {(m.body || (!hasFile && !m.template_name)) && (
            <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: hasFile && isImage ? '6px 9px 2px' : 0 }}>
              {m.body}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, marginTop: 3, padding: hasFile && isImage ? '0 9px 4px' : 0 }}>
            <span style={{ fontSize: 10, opacity: 0.7 }}>
              {new Date(m.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
            {out && !internal && <Ticks status={m.status} />}
          </div>
        </div>

        {failed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--red)', marginTop: 3, justifyContent: 'flex-end', fontWeight: 500 }}>
            <RotateCw size={11} />
            {m.error_detail || 'Not delivered'}
          </div>
        )}
      </div>

      {/* Always present, quiet until touched — reachable by mouse AND thumb. */}
      <button
        onClick={() => setMenu((v) => !v)}
        aria-label="Message actions"
        className="bubble-actions"
        style={{
          width: 28, height: 28, borderRadius: 99, border: 0, background: 'transparent',
          color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', flex: 'none', opacity: menu ? 1 : undefined,
        }}
      >
        <MoreHorizontal size={15} />
      </button>

      {menu && (
        <>
          <div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div
            className="animate-pop-in"
            style={{
              position: 'absolute', zIndex: 31, top: '100%', marginTop: 2,
              [out ? 'right' : 'left']: 34,
              background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 11,
              boxShadow: 'var(--shadow)', minWidth: 190, overflow: 'hidden',
            } as React.CSSProperties}
          >
            <button
              onClick={() => { navigator.clipboard?.writeText(m.body || ''); setMenu(false); }}
              disabled={!m.body}
              style={menuItem}
            >
              <Copy size={14} /> Copy text
            </button>
            {hasFile && (
              <a href={`/api/whatsapp/media/${m.id}?download`} onClick={() => setMenu(false)} style={{ ...menuItem, textDecoration: 'none' }}>
                <Download size={14} /> Download file
              </a>
            )}
            {isAdmin && !internal && (
              <button onClick={() => { setMenu(false); onFlip(); }} style={menuItem}>
                <ArrowLeftRight size={14} /> Move to {out ? 'their' : 'our'} side
              </button>
            )}
            {isAdmin ? (
              <button onClick={() => { setMenu(false); onDelete(); }} style={{ ...menuItem, color: 'var(--red)' }}>
                <Trash2 size={14} /> Delete {internal ? 'note' : 'message'}
              </button>
            ) : (
              <div style={{ padding: '10px 14px', fontSize: 11.5, color: 'var(--muted)' }}>Only an admin can delete.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const menuItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '10px 14px',
  border: 0, borderBottom: '1px solid var(--line-2)', background: 'transparent',
  color: 'var(--ink-2)', fontSize: 12.8, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
};

/** One tick sent, two delivered, both bright teal when read. */
function Ticks({ status }: { status: RelayMessage['status'] }) {
  if (status === 'queued') return <Loader2 size={11} style={{ opacity: 0.7, animation: 'spin .8s linear infinite' }} />;
  if (status === 'failed') return <AlertCircle size={11} style={{ color: 'var(--red)' }} />;
  const read = status === 'read';
  const two = status === 'delivered' || read;
  // WhatsApp blue, at full opacity and slightly larger, so "they have read it"
  // is legible at a glance rather than a subtle tint change.
  const colour = read ? '#34B7F1' : 'currentColor';
  return (
    <svg width={read ? 17 : 15} height={read ? 12 : 11} viewBox="0 0 18 12" fill="none" style={{ opacity: read ? 1 : 0.7 }}>
      <path d="M1 6.5L4.5 10L11 2" stroke={colour} strokeWidth={read ? 2.1 : 1.7} strokeLinecap="round" strokeLinejoin="round" />
      {two && <path d="M7 6.5L10.5 10L17 2" stroke={colour} strokeWidth={read ? 2.1 : 1.7} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function EmptyState() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--chat)', padding: 30 }}>
      <div style={{ textAlign: 'center', maxWidth: 320 }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(140deg,#16b59f,#0a6e62)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19V7a3 3 0 013-3h10a3 3 0 013 3v6a3 3 0 01-3 3H8z" />
          </svg>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 7 }}>Relay</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>Pick a chat on the left, or find someone in Contacts.</p>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 10, border: 0, background: 'transparent',
  color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flex: 'none',
};

const composerBtn: React.CSSProperties = {
  width: 34, height: 34, borderRadius: 9, border: 0, background: 'transparent',
  color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flex: 'none',
};
