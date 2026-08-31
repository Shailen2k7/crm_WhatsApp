'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Lead, RelayUser, Workspace } from '@/lib/types';
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
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Lead | null>(null);
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
          setSelected((cur) => {
            if (!cur || payload.eventType === 'DELETE') return cur;
            const row = payload.new as Lead;
            return row?.id === cur.id ? { ...cur, ...row } : cur;
          });
        }
      )
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, workspace.id]);

  // ---- layout --------------------------------------------------------------
  const showList = !isMobile || !selected;
  const showChat = !isMobile || !!selected;

  return (
    <div style={{ height: '100dvh', display: 'flex', overflow: 'hidden', background: 'var(--bg)' }}>
      <Rail
        active={nav}
        onSelect={(k) => {
          setNav(k);
          if (isMobile) setSelected(null);
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
        userName={user.name}
        unread={0}
      />

      {nav === 'chat' || nav === 'contacts' ? (
        <>
          {showList && (
            <ConversationList
              leads={leads}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              isMobile={isMobile}
            />
          )}
          {showChat && (
            <ChatPanel
              lead={selected}
              workspaceId={workspace.id}
              crmOpen={crmOpen}
              onToggleCrm={() => setCrmOpen((v) => !v)}
              onBack={() => setSelected(null)}
              isMobile={isMobile}
            />
          )}

          {/* Desktop: the CRM record sits beside the chat.
              Mobile: there is no room for a third column, so it slides over the
              chat as a sheet — the lead's details must stay reachable on a
              phone, which is where the team will actually use this. */}
          {selected && crmOpen && !isMobile && <CrmPanel lead={selected} memberName={memberName} />}
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
                <CrmPanel lead={selected} memberName={memberName} onClose={() => setCrmOpen(false)} />
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
