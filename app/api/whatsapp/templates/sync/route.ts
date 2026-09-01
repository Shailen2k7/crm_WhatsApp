// =============================================================================
// TEMPLATE SYNC — attempts to import approved templates from Interakt.
// -----------------------------------------------------------------------------
// STATUS AS OF BUILD TIME: Interakt's only templates route,
// /v1/public/track/templates/, answers HTTP 500 to every request shape tried
// (GET and POST; with and without limit/page/status/template_name/language
// params). The same API key returns a normal 400 validation error from the
// send endpoint, so this is not authentication and not our parameters — the
// route is broken or not enabled on this account's plan.
//
// This endpoint exists anyway, for two reasons:
//   1. the moment Interakt fixes it, sync starts working with no code change;
//   2. it reports the ACTUAL provider response, so "why can't it import?" has
//      a checkable answer instead of my say-so.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InteraktTemplate {
  name?: string;
  template_name?: string;
  language?: string;
  language_code?: string;
  languageCode?: string;
  category?: string;
  status?: string;
  body?: string;
  body_text?: string;
  components?: { type?: string; text?: string }[];
}

/** Pulls the body text out of whichever shape the provider returns. */
function bodyOf(t: InteraktTemplate): string {
  if (t.body) return t.body;
  if (t.body_text) return t.body_text;
  const comp = (t.components || []).find((c) => (c.type || '').toUpperCase() === 'BODY');
  return comp?.text || '';
}

function countVars(body: string): number {
  const m = body.match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return new Set(m.map((x) => x.replace(/\D/g, ''))).size;
}

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, status')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member || member.status !== 'active') {
    return NextResponse.json({ ok: false, error: 'No active membership.' }, { status: 403 });
  }

  const key = process.env.INTERAKT_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: 'INTERAKT_API_KEY is not set.' }, { status: 503 });

  // Every shape worth trying, in order. The first that returns a usable list wins.
  const attempts: { url: string; init: RequestInit }[] = [
    { url: 'https://api.interakt.ai/v1/public/track/templates/', init: { method: 'GET' } },
    { url: 'https://api.interakt.ai/v1/public/track/templates/?limit=200&offset=0', init: { method: 'GET' } },
    {
      url: 'https://api.interakt.ai/v1/public/track/templates/',
      init: { method: 'POST', body: JSON.stringify({ limit: 200, offset: 0 }) },
    },
  ];

  let lastStatus = 0;
  let lastBody = '';

  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        ...a.init,
        headers: { Authorization: `Basic ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      lastStatus = res.status;
      lastBody = text.slice(0, 300);
      if (!res.ok) continue;

      const json = JSON.parse(text) as { templates?: InteraktTemplate[]; data?: InteraktTemplate[]; result?: unknown };
      const list = json.templates || json.data || (Array.isArray(json.result) ? (json.result as InteraktTemplate[]) : null);
      if (!Array.isArray(list)) continue;

      const admin = createAdminClient();
      if (!admin) return NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 });

      const rows = list
        .filter((t) => !t.status || t.status.toUpperCase() === 'APPROVED')
        .map((t) => {
          const body = bodyOf(t);
          return {
            workspace_id: member.workspace_id,
            name: t.name || t.template_name || '',
            language: t.language || t.language_code || t.languageCode || 'en',
            body,
            category: t.category || null,
            variable_count: countVars(body),
          };
        })
        .filter((r) => r.name);

      if (rows.length === 0) {
        return NextResponse.json({ ok: true, imported: 0, note: 'Interakt returned no approved templates.' });
      }

      const { error } = await admin
        .from('relay_templates')
        .upsert(rows, { onConflict: 'workspace_id,name,language' });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

      return NextResponse.json({ ok: true, imported: rows.length, note: `Imported ${rows.length} approved template(s).` });
    } catch {
      // try the next shape
    }
  }

  return NextResponse.json({
    ok: false,
    providerStatus: lastStatus,
    providerBody: lastBody,
    error:
      lastStatus === 500
        ? "Interakt's templates endpoint returned 500 — it is broken on their side, not a problem with your key (sending works with the same key). Add templates below by hand, or ask Interakt support to enable the templates API on your plan."
        : `Interakt returned ${lastStatus}. Add templates below by hand in the meantime.`,
  }, { status: 502 });
}
