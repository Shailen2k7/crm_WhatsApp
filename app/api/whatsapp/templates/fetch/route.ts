// =============================================================================
// FETCH TEMPLATES — what the one button on the Templates page calls.
// -----------------------------------------------------------------------------
// GET   -> is a connection saved? (so the page can show Fetch vs Connect)
// POST  -> import every APPROVED template from Interakt
// PUT   -> save/refresh the Interakt connection (org id + session token)
//
// Only APPROVED templates are imported: a pending or rejected one cannot be
// sent, so listing it would only produce failures in the chat.
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchInteraktTemplates } from '@/lib/interakt-templates';
import { fetchMetaTemplates, metaConfigured } from '@/lib/meta-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORG_KEY = 'interakt_org_id';
const TOKEN_KEY = 'interakt_session_token';

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, status')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active membership.' }, { status: 403 }) };
  }
  const admin = createAdminClient();
  if (!admin) return { error: NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 }) };
  return { workspaceId: member.workspace_id as string, admin };
}

async function settings(admin: NonNullable<ReturnType<typeof createAdminClient>>, ws: string) {
  const { data } = await admin.from('relay_settings').select('key, value').eq('workspace_id', ws);
  const m: Record<string, string> = {};
  for (const r of data || []) if (r.value) m[r.key] = r.value;
  return m;
}

// ---- is there a saved connection? -------------------------------------------
export async function GET() {
  const a = await auth();
  if ('error' in a) return a.error;
  const s = await settings(a.admin, a.workspaceId);
  return NextResponse.json({
    ok: true,
    connected: !!(s[ORG_KEY] && s[TOKEN_KEY]),
    metaAvailable: metaConfigured(),
  });
}

// ---- save / refresh the connection ------------------------------------------
export async function PUT(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;

  const body = await req.json().catch(() => ({}));
  const orgId = String(body.orgId || '').trim();
  const token = String(body.token || '').trim();
  if (!orgId || !token) {
    return NextResponse.json({ ok: false, error: 'Both the organisation id and the token are needed.' }, { status: 400 });
  }

  // Verify BEFORE saving, so a bad paste is caught while the user is still
  // looking at the form rather than the next time they press Fetch.
  const probe = await fetchInteraktTemplates(orgId, token);
  if (!probe.ok) return NextResponse.json({ ok: false, error: probe.error }, { status: 400 });

  const now = new Date().toISOString();
  const { error } = await a.admin.from('relay_settings').upsert([
    { workspace_id: a.workspaceId, key: ORG_KEY, value: orgId, updated_at: now },
    { workspace_id: a.workspaceId, key: TOKEN_KEY, value: token, updated_at: now },
  ], { onConflict: 'workspace_id,key' });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    found: probe.templates.filter((t) => t.status === 'APPROVED').length,
  });
}

// ---- the button --------------------------------------------------------------
export async function POST() {
  const a = await auth();
  if ('error' in a) return a.error;
  const s = await settings(a.admin, a.workspaceId);

  let approved: { name: string; language: string; category: string | null; body: string; variableCount: number }[] = [];
  let source = '';
  let skipped = 0;

  if (s[ORG_KEY] && s[TOKEN_KEY]) {
    const r = await fetchInteraktTemplates(s[ORG_KEY], s[TOKEN_KEY]);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error, expired: r.expired }, { status: 400 });
    approved = r.templates.filter((t) => t.status === 'APPROVED');
    skipped = r.templates.length - approved.length;
    source = 'Interakt';
  } else if (metaConfigured()) {
    const r = await fetchMetaTemplates();
    if (!r.ok) return NextResponse.json({ ok: false, error: `Meta refused: ${r.error}` }, { status: 400 });
    approved = r.templates.filter((t) => t.status === 'APPROVED');
    skipped = r.templates.length - approved.length;
    source = 'Meta';
  } else {
    return NextResponse.json({ ok: false, needsConnection: true, error: 'Connect Interakt first.' }, { status: 400 });
  }

  if (!approved.length) {
    return NextResponse.json({ ok: true, imported: 0, note: `${source} reported no approved templates.` });
  }

  // What do we already have? Used only to report "3 new" honestly, and to keep
  // existing wording if a source ever returns a blank body.
  const { data: existing } = await a.admin
    .from('relay_templates')
    .select('name, language, body')
    .eq('workspace_id', a.workspaceId);
  const known = new Map((existing || []).map((e) => [`${e.name}|${e.language}`, e.body as string]));

  const rows = approved.map((t) => {
    const body = t.body || known.get(`${t.name}|${t.language}`) || '';
    return {
      workspace_id: a.workspaceId,
      name: t.name,
      language: t.language,
      body,
      category: t.category,
      variable_count: t.variableCount || 0,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await a.admin
    .from('relay_templates')
    .upsert(rows, { onConflict: 'workspace_id,name,language' });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const added = rows.filter((r) => !known.has(`${r.name}|${r.language}`)).length;
  return NextResponse.json({
    ok: true,
    source,
    imported: rows.length,
    added,
    note:
      `${rows.length} approved template${rows.length === 1 ? '' : 's'} from ${source}` +
      (added ? ` — ${added} new.` : ' — all up to date.') +
      (skipped ? ` (${skipped} not approved yet, skipped.)` : ''),
  });
}
