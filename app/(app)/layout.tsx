import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RelayShell } from '@/components/relay-shell';
import type { Lead, Workspace } from '@/lib/types';
import { LEAD_COLUMNS } from '@/lib/types';

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

  // ONE page of leads, server-side. The rest are fetched by the browser after
  // the app is on screen (see RelayShell).
  //
  // This used to be a loop of up to 30 sequential queries here. That is what
  // crashed the deploy with a 502: a serverless function has a hard time limit,
  // and thirty round-trips to Postgres blew straight through it. The first page
  // renders the app instantly; the remainder streams in behind it, and a
  // conversation whose lead has not arrived yet still resolves, because the CRM
  // panel looks that lead up directly.
  const { data: firstPage, error: leadsError } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .not('phone', 'is', null)
    .order('updated_at', { ascending: false })
    .range(0, 999);

  if (leadsError) {
    return <Notice title="Could not load leads" body={leadsError.message} />;
  }
  const leads = (firstPage || []) as Lead[];

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
