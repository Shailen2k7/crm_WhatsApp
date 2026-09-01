'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Lead, RelayUser, Workspace } from '@/lib/types';
import type { RelayConversation, RelayMessage } from '@/lib/messages';
import { mergeContacts, type Contact } from '@/lib/contacts';
import { playRingtone, unlockAudio } from '@/lib/chime';
import { enablePush, registerServiceWorker } from '@/lib/push-client';
import { Rail, type RailKey } from './rail';
import { ConversationList } from './conversation-list';
import { ChatPanel } from './chat-panel';
import { CrmPanel } from './crm-panel';
import { SettingsPanel } from './settings-panel';
import { QuickRepliesManager } from './quick-replies';
import { FilesPanel } from './files-panel';
import { Placeholder } from './placeholder';
import { BellRing, X } from 'lucide-react';

interface Member {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

export function RelayShell({
  user,
  workspace,
  role,
  initialLeads,
}: {
  user: RelayUser;
  workspace: Workspace;
  role: 'admin' | 'member';
  initialLeads: Lead[];
  children?: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);

  // Refs so the long-lived realtime subscription always sees current values
  // without being torn down and rebuilt on every render.
  const openConvRef = useRef<string | null>(null);
  const markReadRef = useRef<((id: string) => void) | null>(null);

  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [conversations, setConversations] = useState<RelayConversation[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [nav, setNav] = useState<RailKey>('chat');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [crmOpen, setCrmOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [live, setLive] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [railHover, setRailHover] = useState(false);
  const [pushBanner, setPushBanner] = useState(false);

  // ---- theme ---------------------------------------------------------------
  useEffect(() => {
    const stored = (localStorage.getItem('relay-theme') as 'light' | 'dark' | null) ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(stored);
    document.documentElement.setAttribute('data-theme', stored);
    try {
      setRailExpanded(localStorage.getItem('relay-rail') === 'wide');
    } catch { /* fine */ }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('relay-theme', next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    setRailExpanded((v) => {
      try { localStorage.setItem('relay-rail', v ? 'narrow' : 'wide'); } catch { /* fine */ }
      return !v;
    });
  }, []);

  // ---- PWA + notifications -------------------------------------------------
  useEffect(() => {
    registerServiceWorker();
    // Browsers refuse audio until the user touches the page once.
    const unlock = () => { unlockAudio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // Offer push once, politely, when it has neither been granted nor refused.
    if ('Notification' in window && Notification.permission === 'default') setPushBanner(true);
    if ('Notification' in window && Notification.permission === 'granted') enablePush(); // refresh the subscription silently
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  // ---- responsive ----------------------------------------------------------
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => {
      setIsMobile(mq.matches);
      if (mq.matches) setCrmOpen(false);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // ---- member names --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('list_workspace_members', { p_workspace_id: workspace.id });
      if (!cancelled && Array.isArray(data)) setMembers(data as Member[]);
    })();
    return () => { cancelled = true; };
  }, [supabase, workspace.id]);

  const memberName = useCallback(
    (id: string | null) => {
      if (!id) return 'Unassigned';
      if (id === user.id) return `${user.name} (you)`;
      const m = members.find((x) => x.user_id === id);
      return m?.full_name || m?.email || 'Unknown';
    },
    [members, user.id, user.name]
  );

  // ---- conversations + live updates ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('relay_conversations')
        .select('*')
        .eq('workspace_id', workspace.id)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1000);
      if (!cancelled && data) setConversations(data as RelayConversation[]);
    })();

    const channel = supabase
      .channel('relay-convs-' + workspace.id)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'relay_conversations', filter: `workspace_id=eq.${workspace.id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const gone = (payload.old as { id?: string })?.id;
            if (gone) setConversations((prev) => prev.filter((c) => c.id !== gone));
            return;
          }
          const row = payload.new as RelayConversation;
          if (!row?.id) return;
          setConversations((prev) => {
            const i = prev.findIndex((c) => c.id === row.id);
            if (i === -1) return [row, ...prev];
            const copy = [...prev];
            copy[i] = row;
            return copy;
          });
        }
      )
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [supabase, workspace.id]);

  // ---- THE RINGTONE: any inbound message, any conversation -----------------
  // The chat panel has its own per-thread subscription for rendering; this one
  // exists solely so a message in a thread you are NOT looking at still rings.
  useEffect(() => {
    const channel = supabase
      .channel('relay-inbound-' + workspace.id)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'relay_messages', filter: `workspace_id=eq.${workspace.id}` },
        (payload) => {
          const row = payload.new as RelayMessage;
          if (row?.direction === 'in') {
            playRingtone();
            // Already looking at this thread? Then it is read on arrival.
            if (openConvRef.current && row.conversation_id === openConvRef.current) {
              markReadRef.current?.(row.conversation_id);
            }
            // Title flash so a background tab shows it too.
            if (document.hidden) {
              const original = document.title;
              document.title = '🟢 New message — Relay';
              const back = () => { document.title = original; document.removeEventListener('visibilitychange', back); };
              document.addEventListener('visibilitychange', back);
            }
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, workspace.id]);

  // ---- leads live ----------------------------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel('relay-leads-' + workspace.id)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leads', filter: `workspace_id=eq.${workspace.id}` },
        (payload) => {
          setLeads((prev) => {
            if (payload.eventType === 'DELETE') {
              const gone = (payload.old as { id?: string })?.id;
              return gone ? prev.filter((l) => l.id !== gone) : prev;
            }
            const row = payload.new as Lead;
            if (!row?.id) return prev;
            if (!row.phone) return prev.filter((l) => l.id !== row.id);
            const idx = prev.findIndex((l) => l.id === row.id);
            if (idx === -1) return [row, ...prev];
            const copy = [...prev];
            copy[idx] = { ...copy[idx], ...row };
            return copy;
          });
        }
      )
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    return () => { supabase.removeChannel(channel); };
  }, [supabase, workspace.id]);

  // ---- the lists -----------------------------------------------------------
  const contacts = useMemo(() => mergeContacts(leads, conversations), [leads, conversations]);

  // Chats nav shows ONLY real conversations — the inbox, not the database.
  const chatContacts = useMemo(() => contacts.filter((c) => c.lastMessageAt || c.conversationId), [contacts]);
  const starredContacts = useMemo(() => chatContacts.filter((c) => c.spotlight), [chatContacts]);

  const selected: Contact | null = useMemo(
    () => contacts.find((c) => c.key === selectedKey) ?? null,
    [contacts, selectedKey]
  );

  /**
   * Clearing the unread badge.
   *
   * Two things happen, deliberately, and in this order:
   *   1. the local conversation row is zeroed IMMEDIATELY, so the badge in the
   *      list and on the rail disappears the moment you open the chat rather
   *      than after a database round-trip;
   *   2. the write goes to Postgres, and realtime confirms it for every other
   *      device the team has open.
   *
   * The write is a plain UPDATE rather than the RPC: it runs under the same RLS
   * policy as everything else here, so there is one permission path to reason
   * about instead of two.
   */
  const markRead = useCallback(
    async (conversationId: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId && c.unread_count !== 0 ? { ...c, unread_count: 0 } : c))
      );
      const { error } = await supabase
        .from('relay_conversations')
        .update({ unread_count: 0 })
        .eq('id', conversationId);
      if (error) console.error('[relay] could not mark read', error.message);
    },
    [supabase]
  );

  // Opening a chat reads it. So does coming back to the tab with one open.
  useEffect(() => {
    if (selected?.conversationId && selected.unread > 0) markRead(selected.conversationId);
  }, [selected?.conversationId, selected?.unread, markRead]);

  useEffect(() => {
    const onFocus = () => { if (selected?.conversationId) markRead(selected.conversationId); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [selected?.conversationId, markRead]);
  const totalUnread = useMemo(() => contacts.reduce((n, c) => n + c.unread, 0), [contacts]);

  useEffect(() => { openConvRef.current = selected?.conversationId ?? null; }, [selected?.conversationId]);
  useEffect(() => { markReadRef.current = markRead; }, [markRead]);

  const showList = !isMobile || !selected;
  const showChat = !isMobile || !!selected;

  const isChatNav = nav === 'chat' || nav === 'contacts' || nav === 'starred';
  const listForNav = nav === 'contacts' ? contacts : nav === 'starred' ? starredContacts : chatContacts;

  async function turnOnPush() {
    setPushBanner(false);
    const r = await enablePush();
    if (r === 'denied') alert('Notifications were blocked. Enable them for chat.migrizo.com in your browser settings.');
  }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      {pushBanner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: 'var(--teal)', color: '#fff', fontSize: 12.5, fontWeight: 600, flex: 'none' }}>
          <BellRing size={15} style={{ flex: 'none' }} />
          <span style={{ flex: 1 }}>Turn on notifications so a client message rings on this device — even when Relay is in the background.</span>
          <button onClick={turnOnPush} style={{ background: '#fff', color: 'var(--teal-2)', border: 0, borderRadius: 8, padding: '5px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 'none' }}>
            Turn on
          </button>
          <button onClick={() => setPushBanner(false)} aria-label="Dismiss" style={{ background: 'transparent', border: 0, color: '#fff', cursor: 'pointer', display: 'flex', flex: 'none' }}>
            <X size={15} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* The rail floats over the list while merely hovered, so this spacer
            holds its 62px of layout and nothing lurches sideways. */}
        <div style={{ position: 'relative', width: isMobile ? 62 : railExpanded ? 196 : 62, flex: 'none', transition: 'width .16s ease' }}>
          <Rail
            active={nav}
            onSelect={(k) => { setNav(k); if (isMobile) setSelectedKey(null); }}
            theme={theme}
            onToggleTheme={toggleTheme}
            userName={user.name}
            unread={totalUnread}
            expanded={railExpanded}
            onToggleExpanded={toggleRail}
            isMobile={isMobile}
            onHoverChange={setRailHover}
            hovering={railHover}
          />
        </div>

        {isChatNav ? (
          <>
            {showList && (
              <ConversationList
                contacts={listForNav}
                mode={nav === 'contacts' ? 'contacts' : 'chats'}
                selectedKey={selectedKey}
                onSelect={(c) => setSelectedKey(c.key)}
                isMobile={isMobile}
              />
            )}
            {showChat && (
              <ChatPanel
                contact={selected}
                workspaceId={workspace.id}
                role={role}
                crmOpen={crmOpen}
                onToggleCrm={() => setCrmOpen((v) => !v)}
                onBack={() => setSelectedKey(null)}
                onDeleted={() => setSelectedKey(null)}
                isMobile={isMobile}
              />
            )}
            {selected && crmOpen && !isMobile && <CrmPanel contact={selected} memberName={memberName} />}
            {selected && crmOpen && isMobile && (
              <div onClick={() => setCrmOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 40 }}>
                <div onClick={(e) => e.stopPropagation()} className="animate-fade-in" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, display: 'flex' }}>
                  <CrmPanel contact={selected} memberName={memberName} onClose={() => setCrmOpen(false)} />
                </div>
              </div>
            )}
          </>
        ) : nav === 'quickreplies' ? (
          <QuickRepliesManager workspaceId={workspace.id} />
        ) : nav === 'files' ? (
          <FilesPanel workspaceId={workspace.id} contacts={contacts} onOpenChat={(key) => { setNav('chat'); setSelectedKey(key); }} />
        ) : nav === 'settings' ? (
          <SettingsPanel
            user={user}
            workspace={workspace}
            role={role}
            leadCount={leads.length}
            live={live}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
        ) : (
          <Placeholder nav={nav} />
        )}
      </div>
    </div>
  );
}
