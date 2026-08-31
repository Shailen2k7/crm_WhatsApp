'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Search, Star, PanelRight, MoreHorizontal, Paperclip, Smile, Image as ImageIcon,
  FileText, Mic, Send, MessageSquare, ArrowLeft, AlertCircle, Loader2, RotateCw,
} from 'lucide-react';
import { initialsOf, avatarTint, formatPhone } from '@/lib/phone';
import type { Contact } from '@/lib/contacts';
import { windowState, formatWindow } from '@/lib/interakt';
import type { RelayMessage } from '@/lib/messages';

export function ChatPanel({
  contact,
  workspaceId,
  crmOpen,
  onToggleCrm,
  onBack,
  isMobile,
}: {
  contact: Contact | null;
  workspaceId: string;
  crmOpen: boolean;
  onToggleCrm: () => void;
  onBack: () => void;
  isMobile: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lastInboundAt, setLastInboundAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<RelayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Recomputed every 30s so the window countdown stays honest without a reload.
  const [, setTick] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const phoneE164 = contact?.phoneE164 ?? null;
  const displayName = contact ? (contact.unknown ? formatPhone(contact.phoneE164) : contact.name) : '';
  const firstName = contact && !contact.unknown ? contact.name.split(' ')[0] : 'them';
  const avatarSeed = contact?.key ?? '';

  // ---- load the conversation and its history -------------------------------
  useEffect(() => {
    if (!contact || !phoneE164) {
      setConversationId(null);
      setMessages([]);
      setLastInboundAt(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft('');

    (async () => {
      // Selecting a lead must NOT create a conversation row — that would litter
      // the table with empty threads for every contact anyone clicked. The row
      // is created on the first actual send, by the send route.
      const { data: conv } = await supabase
        .from('relay_conversations')
        .select('id, last_inbound_at')
        .eq('workspace_id', workspaceId)
        .eq('phone_e164', phoneE164)
        .maybeSingle();

      if (cancelled) return;

      if (!conv) {
        setConversationId(null);
        setLastInboundAt(null);
        setMessages([]);
        setLoading(false);
        return;
      }

      setConversationId(conv.id);
      setLastInboundAt(conv.last_inbound_at);

      const { data: msgs } = await supabase
        .from('relay_messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(500);

      if (cancelled) return;
      setMessages((msgs || []) as RelayMessage[]);
      setLoading(false);
      supabase.rpc('relay_mark_read', { p_conversation_id: conv.id });
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, contact, phoneE164, workspaceId]);

  // ---- realtime: new messages and status changes ---------------------------
  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase
      .channel('relay-msgs-' + conversationId)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'relay_messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
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
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, conversationId]);

  // ---- keep the countdown live ---------------------------------------------
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: messages.length > 30 ? 'auto' : 'smooth' });
  }, [messages.length]);

  const win = windowState(lastInboundAt);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !contact || sending) return;
    setSending(true);
    setError(null);

    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: contact.phoneRaw,
          leadId: contact.leadId,
          conversationId: conversationId || undefined,
          message: text,
        }),
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setError(json.error || 'Could not send.');
        // The draft is NOT cleared on failure — losing what someone typed
        // because a provider hiccuped is unforgivable in a chat app.
        setSending(false);
        return;
      }

      setDraft('');
      if (!conversationId && json.conversationId) setConversationId(json.conversationId);
      // Realtime delivers the row; if the socket is down, pull it once.
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
      setError('Network error — the message was not sent.');
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }, [draft, contact, sending, conversationId, supabase]);

  if (!contact) return <EmptyState />;

  const canType = win.open;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--chat)' }}>
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 14px', background: 'var(--surface)', borderBottom: '1px solid var(--line)', flex: 'none' }}>
        {isMobile && (
          <button onClick={onBack} aria-label="Back" style={iconBtn}>
            <ArrowLeft size={18} />
          </button>
        )}
        <div style={{ width: 38, height: 38, borderRadius: 99, background: contact.unknown ? 'var(--surface-3)' : avatarTint(avatarSeed), color: contact.unknown ? 'var(--muted)' : '#fff', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          {contact.unknown ? '?' : initialsOf(contact.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </span>
            {contact.unknown ? (
              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--amber-bg)', color: 'var(--amber)', flex: 'none' }}>
                Not in CRM
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--teal-bg)', color: 'var(--teal-ink)', flex: 'none' }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                CRM linked
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{formatPhone(contact.phoneE164)}</div>
        </div>
        <button aria-label="Search in conversation" style={iconBtn}><Search size={17} /></button>
        <button aria-label="Star" style={iconBtn}><Star size={17} /></button>
        <button onClick={onToggleCrm} aria-label="Toggle CRM panel" style={{ ...iconBtn, background: crmOpen ? 'var(--surface-3)' : 'transparent', color: crmOpen ? 'var(--teal-ink)' : 'var(--muted)' }}>
          <PanelRight size={17} />
        </button>
        <button aria-label="More" style={iconBtn}><MoreHorizontal size={17} /></button>
      </header>

      {/* Thread */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '16px 18px 6px' }}>
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
                <Bubble message={m} />
              </div>
            );
          })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div style={{ padding: '8px 14px 14px', flex: 'none' }}>
        {error && (
          <div className="animate-fade-in" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: 'var(--red-bg)', color: 'var(--red)', padding: '9px 12px', borderRadius: 10, fontSize: 12.3, fontWeight: 500, marginBottom: 8, lineHeight: 1.5 }}>
            <AlertCircle size={14} style={{ flex: 'none', marginTop: 1 }} />
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontWeight: 700, flex: 'none' }}>×</button>
          </div>
        )}

        {!canType && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--amber-bg)', color: 'var(--ink-2)', padding: '9px 12px', borderRadius: 10, fontSize: 12.3, marginBottom: 8, lineHeight: 1.5 }}>
            <AlertCircle size={14} style={{ flex: 'none', color: 'var(--amber)' }} />
            <span>
              <strong>24-hour window closed.</strong> WhatsApp only allows an approved template until they reply.
              Templates arrive next — for now, ask them to message you first.
            </span>
          </div>
        )}

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, boxShadow: 'var(--shadow)', opacity: canType ? 1 : 0.6 }}>
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!canType || sending}
            rows={1}
            placeholder={canType ? `Message ${firstName}…    ⏎ send · ⇧⏎ new line` : 'Window closed — an approved template is required'}
            style={{
              width: '100%',
              border: 0,
              outline: 0,
              resize: 'none',
              background: 'transparent',
              padding: '14px 16px 4px',
              fontSize: 14,
              lineHeight: 1.5,
              maxHeight: 140,
              minHeight: 46,
              cursor: canType ? 'text' : 'not-allowed',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 10px 9px' }}>
            {[Smile, Paperclip, ImageIcon, FileText, Mic].map((Icon, i) => (
              <span key={i} title="Attachments arrive in Phase 4" style={{ width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', opacity: 0.5 }}>
                <Icon size={16} />
              </span>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: win.open ? 'var(--muted)' : 'var(--amber)', marginRight: 9, fontWeight: win.open ? 400 : 600 }}>
              24h window · {formatWindow(win.msLeft)}
            </span>
            <button
              onClick={send}
              disabled={!canType || sending || !draft.trim()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 9,
                border: 0,
                background: canType && draft.trim() ? 'var(--teal)' : 'var(--surface-3)',
                color: canType && draft.trim() ? '#fff' : 'var(--muted)',
                fontSize: 13,
                fontWeight: 600,
                cursor: canType && draft.trim() && !sending ? 'pointer' : 'not-allowed',
              }}
            >
              {sending ? <Loader2 size={13} style={{ animation: 'spin .8s linear infinite' }} /> : <Send size={13} />}
              {sending ? 'Sending' : 'Send'}
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
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {label}
      </span>
    </div>
  );
}

function Bubble({ message: m }: { message: RelayMessage }) {
  const out = m.direction === 'out';
  const failed = m.status === 'failed';

  return (
    <div className="animate-msg-in" style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginBottom: 7 }}>
      <div style={{ maxWidth: '68%', minWidth: 90 }}>
        <div
          style={{
            background: failed ? 'var(--red-bg)' : out ? 'var(--out-bg)' : 'var(--in-bg)',
            color: failed ? 'var(--ink)' : out ? 'var(--out-fg)' : 'var(--in-fg)',
            border: out || failed ? 'none' : '1px solid var(--line-2)',
            borderRadius: out ? '13px 13px 4px 13px' : '13px 13px 13px 4px',
            padding: '9px 13px 7px',
            boxShadow: 'var(--shadow)',
          }}
        >
          {m.template_name && (
            <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.75, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Template · {m.template_name}
            </div>
          )}
          <div style={{ fontSize: 13.6, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {m.body || (m.media_url ? '[attachment]' : '')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, marginTop: 3 }}>
            <span style={{ fontSize: 10, opacity: 0.7 }}>
              {new Date(m.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
            {out && <Ticks status={m.status} />}
          </div>
        </div>

        {failed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--red)', marginTop: 3, justifyContent: 'flex-end', fontWeight: 500 }}>
            <RotateCw size={11} />
            {m.error_detail || 'Not delivered'}
          </div>
        )}
      </div>
    </div>
  );
}

/** One tick sent, two delivered, two filled read — the convention people know. */
function Ticks({ status }: { status: RelayMessage['status'] }) {
  if (status === 'queued') return <Loader2 size={11} style={{ opacity: 0.7, animation: 'spin .8s linear infinite' }} />;
  if (status === 'failed') return <AlertCircle size={11} style={{ color: 'var(--red)' }} />;

  const read = status === 'read';
  const two = status === 'delivered' || read;

  return (
    <svg width="15" height="11" viewBox="0 0 18 12" fill="none" style={{ opacity: read ? 1 : 0.75 }}>
      <path d="M1 6.5L4.5 10L11 2" stroke={read ? '#7DF3DA' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      {two && (
        <path d="M7 6.5L10.5 10L17 2" stroke={read ? '#7DF3DA' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      )}
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
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
          Pick a contact on the left to open their conversation.
        </p>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 9, border: 0, background: 'transparent',
  color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flex: 'none',
};
