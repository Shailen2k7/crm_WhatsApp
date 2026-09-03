'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Search, Star, PanelRight, Paperclip, Send, MessageSquare, ArrowLeft,
  AlertCircle, Loader2, RotateCw, Lock, FileText, Download, X, Trash2,
  MoreHorizontal, Zap, Image as ImageIcon, Copy, ArrowLeftRight,
} from 'lucide-react';
import { initialsOf, avatarTint, formatPhone } from '@/lib/phone';
import type { Contact } from '@/lib/contacts';
import { windowState, formatWindow } from '@/lib/interakt';
import type { RelayMessage, QuickReply, RelayTemplate } from '@/lib/messages';
import { LayoutTemplate } from 'lucide-react';

// =============================================================================
// SPEED: a per-conversation message cache.
// -----------------------------------------------------------------------------
// Opening a chat used to run two sequential queries every single time — one to
// find the conversation by phone, one for its messages — and fetched the OLDEST
// 500 rows at that (ascending + limit takes from the top of the sort). Both
// are gone: the conversation comes free with the contact row, only the NEWEST
// 200 messages are pulled (descending, then reversed), and a revisited chat
// paints instantly from this cache while a background refresh reconciles it.
// =============================================================================
const messageCache = new Map<string, RelayMessage[]>();

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
  quickReplies,
  templates,
  crmOpen,
  onToggleCrm,
  onBack,
  onDeleted,
  isMobile,
}: {
  contact: Contact | null;
  workspaceId: string;
  role: 'admin' | 'member';
  quickReplies: QuickReply[];
  templates: RelayTemplate[];
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
  const [qrOpen, setQrOpen] = useState(false);
  const [qrIndex, setQrIndex] = useState(0);
  const [tplOpen, setTplOpen] = useState(false);
  const [, setTick] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  /** Is the reader parked at the live end of the thread? Kept in a ref because
   *  the scroll handler and the message effect both need it without re-binding. */
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const contactKey = contact?.key ?? null;
  const phoneE164 = contact?.phoneE164 ?? null;
  const displayName = contact ? (contact.unknown ? formatPhone(contact.phoneE164) : contact.name) : '';
  const firstName = contact && !contact.unknown ? contact.name.split(' ')[0] : 'them';
  const avatarSeed = contact?.key ?? '';

  // ---- conversation + history ---------------------------------------------
  useEffect(() => {
    if (!contact || !contactKey || !phoneE164) {
      setConversationId(null); setMessages([]); setLastInboundAt(null); setSpotlight(false);
      return;
    }
    let cancelled = false;
    lastCountRef.current = 0;
    setError(null); setDraft(''); setPending([]); setInternal(false);

    (async () => {
      // The contact row from the list already carries the conversation — no
      // lookup round-trip. Only a contact opened before any thread exists
      // falls back to the phone query.
      let convId: string | null = contact.conversationId;
      let convInbound = contact.conversation?.last_inbound_at ?? null;
      let convSpot = contact.conversation?.spotlight ?? false;

      if (!convId) {
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
        convId = conv.id; convInbound = conv.last_inbound_at; convSpot = !!conv.spotlight;
      }

      if (!convId) return;
      const cid: string = convId;
      setConversationId(cid);
      setLastInboundAt(convInbound);
      setSpotlight(convSpot);

      // Cached thread paints NOW; the fetch below reconciles it silently.
      const cached = messageCache.get(cid);
      if (cached) {
        lastCountRef.current = cached.length;
        setMessages(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }

      // Newest 200, not oldest 500: ascending+limit was returning the START of
      // long threads and silently dropping the recent messages.
      const { data: msgs } = await supabase
        .from('relay_messages')
        .select('*')
        .eq('conversation_id', cid)
        .order('created_at', { ascending: false })
        .limit(200);

      if (cancelled) return;
      const ordered = ((msgs || []) as RelayMessage[]).reverse();
      messageCache.set(cid, ordered);
      setMessages(ordered);
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
            const next = i === -1 ? [...prev, row] : prev.map((m, j) => (j === i ? row : m));
            messageCache.set(conversationId, next);
            return next;
          });
          if (row.direction === 'in') setLastInboundAt(row.created_at);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, conversationId]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const scrollToEnd = useCallback((smooth = false) => {
    const el = threadRef.current;
    if (!el) return;
    // scrollTop, not scrollIntoView: scrollIntoView also scrolls ANCESTORS,
    // which on a phone drags the whole page and feels like a snag.
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, []);

  /** Follow the live end only while the reader is already there. */
  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickRef.current = near;
    setAtBottom((was) => (was === near ? was : near));
    if (near) setUnseen(0);
  }, []);

  // WhatsApp does not drag you to the bottom while you are reading history —
  // it counts what arrived and lets you go down when you choose. This does the
  // same: follow only if already at the end, otherwise raise the pill.
  const lastCountRef = useRef(0);
  useEffect(() => {
    const prev = lastCountRef.current;
    if (messages.length === prev) return;
    lastCountRef.current = messages.length;
    if (messages.length < prev) return;           // a delete: leave the view alone

    if (stickRef.current) scrollToEnd(prev > 0 && messages.length - prev === 1);
    else setUnseen((n) => n + (messages.length - prev));
  }, [messages.length, scrollToEnd]);

  // Opening a different chat always starts at the newest message, instantly.
  useEffect(() => {
    lastCountRef.current = 0;
    stickRef.current = true;
    setUnseen(0);
    setAtBottom(true);
  }, [conversationId]);

  // "/" at the start of an empty composer opens quick replies — muscle memory
  // from every serious support tool.
  useEffect(() => {
    setQrOpen(draft === '/' || (draft.startsWith('/') && draft.length <= 20 && !draft.includes(' ')));
    setQrIndex(0); // typing narrows the list; the highlight restarts at the top
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

      const wasNewConversation = !conversationId;
      setDraft(''); setPending([]); setInternal(false);
      if (wasNewConversation && json.conversationId) setConversationId(json.conversationId);
      if (json.partialFailures > 0) setError(`${json.partialFailures} file(s) failed to send — they stay in the thread marked failed.`);

      // A brand-new conversation has no live subscription yet, so pull its
      // messages once. An existing thread needs NO refetch — realtime delivers
      // the sent row in milliseconds. Dropping this 500-row round-trip is the
      // main "sending is slow" fix.
      if (wasNewConversation && json.conversationId) {
        const { data } = await supabase
          .from('relay_messages')
          .select('*')
          .eq('conversation_id', json.conversationId)
          .order('created_at', { ascending: false })
          .limit(200);
        if (data) { const ordered = (data as RelayMessage[]).reverse(); messageCache.set(json.conversationId, ordered); setMessages(ordered); }
      }
    } catch {
      setError('Network error — nothing was sent.');
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }, [draft, pending, internal, contact, sending, conversationId, supabase]);

  // ---- send an approved template (works with the window CLOSED — that is
  // its whole purpose) --------------------------------------------------------
  const [tplSending, setTplSending] = useState<string | null>(null);

  /**
   * Values we send for a template's {{1}} {{2}} … placeholders, best guess in
   * order. The agent is never asked: the CRM already knows who this is, and a
   * template picker that interrogates you is not a picker.
   *
   * If the count is wrong the SERVER learns the right one from Interakt's
   * rejection and retries with the same list — see the send route.
   */
  function autoValues(): string[] {
    const first = contact && !contact.unknown ? contact.name.split(' ')[0] : 'there';
    const visa =
      contact?.lead?.visa_type?.toLowerCase().includes('ifv') || contact?.lead?.visa_type?.toLowerCase().includes('innovator')
        ? 'Innovator Founder Visa'
        : 'Global Talent Visa';
    return [first, visa, 'Migrizo'];
  }

  /** Pick a template -> it sends. That is the whole interaction. */
  async function sendTemplateNow(t: RelayTemplate) {
    if (!contact || tplSending) return;
    setTplSending(t.id);
    setError(null);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: contact.phoneRaw,
          conversationId: conversationId || undefined,
          templateName: t.name,
          templateLanguage: t.language,
          autoValues: autoValues(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json.error || 'Template send failed.'); setTplSending(null); return; }

      const wasNew = !conversationId;
      setTplOpen(false);
      if (wasNew && json.conversationId) setConversationId(json.conversationId);
      if (wasNew && json.conversationId) {
        const { data } = await supabase
          .from('relay_messages').select('*')
          .eq('conversation_id', json.conversationId)
          .order('created_at', { ascending: false }).limit(200);
        if (data) { const ordered = (data as RelayMessage[]).reverse(); messageCache.set(json.conversationId, ordered); setMessages(ordered); }
      }
    } catch {
      setError('Network error — the template was not sent.');
    } finally {
      setTplSending(null);
    }
  }

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

  /**
   * Re-send a message that failed. Reconstructs the payload from the stored
   * row (text or file) and posts it fresh, then removes the failed one.
   */
  async function retryMessage(m: RelayMessage) {
    if (!contact) return;
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        phone: contact.phoneRaw,
        conversationId: conversationId || undefined,
      };
      if (m.template_name) {
        payload.templateName = m.template_name;
        payload.templateLanguage = m.template_language || 'en';
        payload.autoValues = autoValues();
      } else if (m.media_path) {
        payload.message = m.body || '';
        payload.attachments = [{ path: m.media_path, name: m.media_name, mime: m.media_mime, size: m.media_size }];
      } else {
        payload.message = m.body;
      }
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json.error || 'Retry failed.'); return; }
      // remove the old failed row; realtime delivers the new one
      await supabase.from('relay_messages').delete().eq('id', m.id);
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
    } catch {
      setError('Network error on retry.');
    }
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
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--chat)' }}>
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
        ref={threadRef}
        onScroll={onThreadScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          // Keeps a flick at either end from scrolling the page behind the
          // thread, which on mobile reads as the scroll "sticking".
          overscrollBehavior: 'contain',
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
                <Bubble message={m} isAdmin={role === 'admin'} onDelete={() => deleteMessage(m.id)} onFlip={() => flipSide(m)} onRetry={() => retryMessage(m)} />
              </div>
            );
          })}
        <div ref={bottomRef} />
      </div>

      {/* Jump back to the live end. Appears only when you have scrolled away,
          and counts anything that arrived while you were reading — so a new
          message never steals the screen mid-sentence. */}
      {!atBottom && (
        <button
          onClick={() => scrollToEnd(true)}
          aria-label={unseen > 0 ? `${unseen} new message${unseen === 1 ? '' : 's'} — jump to latest` : 'Jump to latest'}
          className="animate-pop-in"
          style={{
            position: 'absolute', right: 18, bottom: 92, zIndex: 15,
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: unseen > 0 ? '8px 14px' : 0,
            width: unseen > 0 ? 'auto' : 38, height: 38,
            justifyContent: 'center',
            borderRadius: 99, border: '1px solid var(--line)',
            background: unseen > 0 ? 'var(--teal)' : 'var(--surface)',
            color: unseen > 0 ? '#fff' : 'var(--muted)',
            fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,.18)',
          }}
        >
          {unseen > 0 && <span>{unseen} new</span>}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

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
            <div style={{ padding: '9px 14px 5px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>Quick replies · ↑↓ then ⏎</div>
            {qrMatches.map((q, qi) => (
              <button key={q.id} onClick={() => applyQuickReply(q)} onMouseEnter={() => setQrIndex(qi)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', border: 0, borderTop: '1px solid var(--line-2)', background: qi === qrIndex ? 'var(--surface-3)' : 'transparent', cursor: 'pointer' }}>
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

        {tplOpen && (
          <div className="animate-pop-in" style={{ position: 'absolute', left: 12, right: 12, bottom: '100%', marginBottom: 6, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, boxShadow: 'var(--shadow)', maxHeight: 320, overflowY: 'auto', zIndex: 21 }}>
            <div style={{ padding: '10px 14px 6px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>
              Templates — tap to send{!win.open ? ' (works with the window closed)' : ''}
            </div>
            {templates.length === 0 && (
              <div style={{ padding: '12px 14px 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                None registered yet. Add your approved templates under <strong>Templates</strong> in the sidebar.
              </div>
            )}
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => sendTemplateNow(t)}
                disabled={!!tplSending}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '12px 14px', border: 0, borderTop: '1px solid var(--line-2)', background: 'transparent', cursor: tplSending ? 'default' : 'pointer' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99, background: 'var(--teal-bg)', color: 'var(--teal-ink)' }}>{t.language}</span>
                  </div>
                  <div style={{ fontSize: 11.8, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.body
                      ? t.body.replace(/\{\{\s*1\s*\}\}/g, firstName)
                      : `Sends the approved wording to ${firstName}`}
                  </div>
                </div>
                {tplSending === t.id
                  ? <Loader2 size={16} style={{ animation: 'spin .8s linear infinite', color: 'var(--teal)', flex: 'none' }} />
                  : <Send size={15} style={{ color: 'var(--teal)', flex: 'none' }} />}
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
              // While the "/" popover is open the arrows walk it and Enter
              // picks — exactly how a command palette behaves.
              if (qrOpen && qrMatches.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setQrIndex((i) => (i + 1) % qrMatches.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setQrIndex((i) => (i - 1 + qrMatches.length) % qrMatches.length); return; }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyQuickReply(qrMatches[Math.min(qrIndex, qrMatches.length - 1)]); return; }
                if (e.key === 'Tab') { e.preventDefault(); applyQuickReply(qrMatches[Math.min(qrIndex, qrMatches.length - 1)]); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              if (e.key === 'Escape') { setQrOpen(false); setTplOpen(false); }
            }}
            disabled={(!canType && !internal) || sending}
            rows={1}
            placeholder={
              internal
                ? 'Note for the team — never sent to the client'
                : canType
                ? `Message ${firstName}…   ⏎ send · / quick replies`
                : `24h window closed — use a template ▦ or write a note 🔒`
            }
            style={{
              width: '100%', border: 0, outline: 0, resize: 'none', background: 'transparent',
              // ~20% more room to write, and the placeholder no longer clips.
              padding: '14px 16px 6px', fontSize: 15, lineHeight: 1.55, maxHeight: 168, minHeight: 58,
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
              {uploading ? <Loader2 size={15} style={{ animation: 'spin .8s linear infinite' }} /> : <Paperclip size={15} />}
            </button>
            <button
              onClick={() => { setDraft((d) => (d.startsWith('/') ? d : '/')); taRef.current?.focus(); }}
              title="Quick replies ( / )"
              aria-label="Quick replies"
              style={composerBtn}
            >
              <Zap size={15} />
            </button>
            <button
              onClick={() => setTplOpen((v) => !v)}
              title="Send an approved template (works when the window is closed)"
              aria-label="Send a template"
              style={{ ...composerBtn, color: tplOpen ? 'var(--teal-ink)' : 'var(--muted)' }}
            >
              <LayoutTemplate size={15} />
            </button>
            <button
              onClick={() => setInternal((v) => !v)}
              title={internal ? 'Back to WhatsApp message' : 'Internal note — team only'}
              aria-label="Toggle internal note"
              style={{ ...composerBtn, background: internal ? 'var(--amber)' : 'transparent', color: internal ? '#fff' : 'var(--muted)' }}
            >
              <Lock size={15} />
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
              aria-label={internal ? 'Save note' : 'Send'}
              title={internal ? 'Save note' : 'Send'}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 38, height: 38, borderRadius: 99, border: 0, flex: 'none',
                background: canSend ? (internal ? 'var(--amber)' : 'var(--teal)') : 'var(--surface-3)',
                color: canSend ? '#fff' : 'var(--muted)',
                cursor: canSend ? 'pointer' : 'not-allowed',
                transition: 'background .15s',
              }}
            >
              {sending ? <Loader2 size={16} style={{ animation: 'spin .8s linear infinite' }} /> : internal ? <Lock size={16} /> : <Send size={16} />}
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

/**
 * Memoised on the message's identity and the fields that actually change
 * (status ticks, edited body). Without this, one 30-second timer re-rendered
 * every bubble in the thread — which is what made a long chat feel sticky.
 */
const Bubble = memo(function Bubble({ message: m, isAdmin, onDelete, onFlip, onRetry }: { message: RelayMessage; isAdmin: boolean; onDelete: () => void; onFlip: () => void; onRetry: () => void }) {
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
              {/* A lazy image with no reserved height is the classic cause of
                  jumpy scrolling: it loads while you are reading, suddenly
                  claims 300px, and shoves the thread under your thumb. A fixed
                  aspect ratio reserves the exact box up front, so nothing
                  moves when the bytes arrive. */}
              <img
                src={`/api/whatsapp/media/${m.id}`}
                alt={m.media_name || 'photo'}
                width={320}
                height={240}
                style={{
                  display: 'block', width: '100%', height: 'auto',
                  aspectRatio: '4 / 3', maxHeight: 340, objectFit: 'cover',
                  borderRadius: 10, background: 'var(--surface-3)',
                }}
                loading="lazy"
                decoding="async"
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

          {((m.body && !(hasFile && (m.body === 'None' || m.body === 'null'))) || (!hasFile && !m.template_name)) && (
            <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: hasFile && isImage ? '6px 9px 2px' : 0 }}>
              {/* Messages sent before the wording was captured are stored as
                  "[template: x]". Show the template name rather than the raw
                  placeholder, so old history reads sensibly too. */}
              {/^\[template:\s*(.+)\]$/.test(m.body)
                ? `Template “${m.body.replace(/^\[template:\s*/, '').replace(/\]$/, '')}”`
                : m.body}
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
          <button
            onClick={onRetry}
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--red)', marginTop: 3, marginLeft: 'auto', fontWeight: 600, background: 'transparent', border: 0, cursor: 'pointer' }}
            title="Tap to retry"
          >
            <RotateCw size={11} />
            {m.error_detail || 'Not delivered'} · Retry
          </button>
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
});

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
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 7 }}>Migrizo</div>
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

const miniBtn: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 7, border: '1px solid var(--line)',
  background: 'transparent', color: 'var(--muted)', fontSize: 14, fontWeight: 700,
  cursor: 'pointer', lineHeight: 1, flex: 'none',
};

const composerBtn: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 8, border: 0, background: 'transparent',
  color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flex: 'none',
};
