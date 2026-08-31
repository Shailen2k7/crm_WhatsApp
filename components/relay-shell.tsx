'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Lead, RelayUser, Workspace } from '@/lib/types';
import type { RelayConversation } from '@/lib/messages';
import { mergeContacts, type Contact } from '@/lib/contacts';
import { Rail, type RailKey } from './rail';
import { ConversationList } from './conversation-list';
import { ChatPanel } from './chat-panel';
import { CrmPanel } from './crm-panel';
import { SettingsPanel } from './settings-panel';
import { Placeholder } from './placeholder';

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

  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [conversations, setConversations] = useState<RelayConversation[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [nav, setNav] = useState<RailKey>('chat');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [crmOpen, setCrmOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [live, setLive] = useState(false);

  // ---- theme ---------------------------------------------------------------
  useEffect(() => {
    const stored = (localStorage.getItem('relay-theme') as 'light' | 'dark' | null) ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(stored);
    document.documentElement.setAttribute('data-theme', stored);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('relay-theme', next);
      } catch {
        /* private mode — the theme just won't persist */
      }
      return next;
    });
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
    return () => {
      cancelled = true;
    };
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

  // ---- conversations: the OTHER half of the list. A thread can exist without
  // a lead (a stranger messaged us), so these are loaded independently and
  // fused with leads in mergeContacts.
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

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase, workspace.id]);

  // ---- realtime: the CRM and Relay share one database, so a lead edited in
  // the CRM must move here without a refresh. This is the proof of that.
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
            // A lead with no phone cannot be a WhatsApp conversation.
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

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, workspace.id]);

  // ---- the list --------------------------------------------------------------
  const contacts = useMemo(() => mergeContacts(leads, conversations), [leads, conversations]);
  const selected: Contact | null = useMemo(
    () => contacts.find((c) => c.key === selectedKey) ?? null,
    [contacts, selectedKey]
  );
  const totalUnread = useMemo(() => contacts.reduce((n, c) => n + c.unread, 0), [contacts]);

  const showList = !isMobile || !selected;
  const showChat = !isMobile || !!selected;

  return (
    <div style={{ height: '100dvh', display: 'flex', overflow: 'hidden', background: 'var(--bg)' }}>
      <Rail
        active={nav}
        onSelect={(k) => {
          setNav(k);
          if (isMobile) setSelectedKey(null);
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
        userName={user.name}
        unread={totalUnread}
      />

      {nav === 'chat' || nav === 'contacts' ? (
        <>
          {showList && (
            <ConversationList
              contacts={contacts}
              selectedKey={selectedKey}
              onSelect={(c) => setSelectedKey(c.key)}
              isMobile={isMobile}
            />
          )}
          {showChat && (
            <ChatPanel
              contact={selected}
              workspaceId={workspace.id}
              crmOpen={crmOpen}
              onToggleCrm={() => setCrmOpen((v) => !v)}
              onBack={() => setSelectedKey(null)}
              isMobile={isMobile}
            />
          )}

          {/* Desktop: the CRM record sits beside the chat.
              Mobile: there is no room for a third column, so it slides over the
              chat as a sheet — the lead's details must stay reachable on a
              phone, which is where the team will actually use this. */}
          {selected && crmOpen && !isMobile && <CrmPanel contact={selected} memberName={memberName} />}
          {selected && crmOpen && isMobile && (
            <div
              onClick={() => setCrmOpen(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 40 }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="animate-fade-in"
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, display: 'flex' }}
              >
                <CrmPanel contact={selected} memberName={memberName} onClose={() => setCrmOpen(false)} />
              </div>
            </div>
          )}
        </>
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
  );
}
