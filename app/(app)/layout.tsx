import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RelayShell } from '@/components/relay-shell';
import type { Lead, Workspace } from '@/lib/types';

// The real auth gate. Middleware fails soft by design, so this server-side
// getUser() is what actually protects the app — same discipline as the CRM.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect('/login');

  const displayName =
    (user.user_metadata?.full_name as string) ||
    (user.user_metadata?.name as string) ||
    (user.email || '').split('@')[0];

  // Membership decides which workspace's leads this person may read. RLS
  // enforces it again at the database, so this is for routing, not security.
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, status, workspaces:workspaces(id, name)')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!member) {
    return (
      <Notice
        title="Account not linked"
        body={`${user.email} exists in Supabase but isn't a member of any workspace. An admin needs to add you in the CRM.`}
      />
    );
  }
  if (member.status === 'pending') {
    return <Notice title="Awaiting approval" body="Your account is pending. An admin needs to approve you in the CRM." />;
  }
  if (member.status === 'paused') {
    return <Notice title="Access paused" body="Your account has been paused. Contact an admin." />;
  }

  const workspace = (member.workspaces as unknown as Workspace) || { id: member.workspace_id, name: 'Migrizo' };

  // EVERY lead with a phone number — paginated, because a single query is
  // capped (PostgREST returns at most 1000 rows by default) and a truncated
  // list is not a smaller list, it is a WRONG one: a conversation whose lead
  // fell past the cut-off renders as "Not in CRM" even though the CRM knows
  // exactly who they are. That bug is why this loop exists.
  const COLUMNS =
    'id, workspace_id, full_name, phone, email, visa_type, stage, source, owner_id, industry, tags, next_follow_up, last_note, last_note_at, first_response_at, cv_path, cv_name, created_at, updated_at, is_sample';

  const PAGE = 1000;
  const MAX_PAGES = 30; // 30k leads — far beyond today, and a hard stop either way
  const leads: Lead[] = [];
  let leadsError: { message: string } | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('leads')
      .select(COLUMNS)
      .not('phone', 'is', null)
      .order('updated_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (error) { leadsError = error; break; }
    if (!data || data.length === 0) break;
    leads.push(...(data as Lead[]));
    if (data.length < PAGE) break;
  }

  if (leadsError) {
    return <Notice title="Could not load leads" body={leadsError.message} />;
  }

  return (
    <RelayShell
      user={{ id: user.id, email: user.email || '', name: displayName }}
      workspace={workspace}
      role={(member.role as 'admin' | 'member') || 'member'}
      initialLeads={leads}
    >
      {children}
    </RelayShell>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
      <div style={{ maxWidth: 400, textAlign: 'center', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 30, boxShadow: 'var(--shadow)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{title}</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 18px' }}>{body}</p>
        <a href="/login" style={{ display: 'inline-flex', padding: '9px 18px', borderRadius: 9, background: 'var(--teal)', color: '#fff', fontWeight: 600, fontSize: 13 }}>
          Back to sign in
        </a>
      </div>
    </div>
  );
}
