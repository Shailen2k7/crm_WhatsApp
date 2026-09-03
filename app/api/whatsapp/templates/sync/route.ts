// =============================================================================
// TEMPLATE SYNC — pulls every approved template into our own registry.
// -----------------------------------------------------------------------------
// TWO SOURCES, tried in order:
//
//   1. META (works). Meta owns the templates, so we ask the owner. Needs
//      META_ACCESS_TOKEN; the WABA id is discovered from the token unless
//      META_WABA_ID is given.
//
//   2. INTERAKT (broken on their side). Their only templates route,
//      /v1/public/track/templates/, has answered HTTP 500 to every request
//      shape tried — GET and POST, with and without limit/offset/page/status.
//      The same key returns a normal 400 from the SEND endpoint, so this is
//      neither our authentication nor our parameters. Kept as a fallback so it
//      starts working the day they fix it, with no code change here.
//
// Whatever the source, the result is the same: name, language, category, the
// approved body text, and how many {{n}} values a send must supply.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchMetaTemplates, metaConfigured, countVars } from '@/lib/meta-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InteraktTemplate {
  name?: string; template_name?: string;
  language?: string; language_code?: string; languageCode?: string;
  category?: string; status?: string;
  body?: string; body_text?: string;
  components?: { type?: string; text?: string }[];
}

function bodyOf(t: InteraktTemplate): string {
  if (t.body) return t.body;
  if (t.body_text) return t.body_text;
  return (t.components || []).find((c) => (c.type || '').toUpperCase() === 'BODY')?.text || '';
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

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 });

  /** Writes rows and keeps existing wording if a source hands back an empty body. */
  async function save(rows: {
    workspace_id: string; name: string; language: string;
    body: string; category: string | null; variable_count: number;
  }[]) {
    const { data: existing } = await admin!
      .from('relay_templates')
      .select('name, language, body')
      .eq('workspace_id', member!.workspace_id);
    const known = new Map((existing || []).map((e) => [`${e.name}|${e.language}`, e.body as string]));

    const merged = rows.map((r) => {
      if (r.body) return r;
      const old = known.get(`${r.name}|${r.language}`);
      return old ? { ...r, body: old, variable_count: countVars(old) } : r;
    });

    const { error } = await admin!
      .from('relay_templates')
      .upsert(merged, { onConflict: 'workspace_id,name,language' });
    return error?.message || null;
  }

  // ---- 1. META -------------------------------------------------------------
  if (metaConfigured()) {
    const meta = await fetchMetaTemplates();
    if (meta.ok) {
      const approved = meta.templates.filter((t) => t.status === 'APPROVED');
      const rows = approved.map((t) => ({
        workspace_id: member.workspace_id,
        name: t.name,
        language: t.language,
        body: t.body,
        category: t.category,
        variable_count: t.variableCount,
      }));

      if (!rows.length) {
        return NextResponse.json({
          ok: true, imported: 0,
          note: `Meta answered, but this account (${meta.wabaId}) has no APPROVED templates — it has ${meta.templates.length} in other states.`,
        });
      }

      const err = await save(rows);
      if (err) return NextResponse.json({ ok: false, error: err }, { status: 500 });

      const skipped = meta.templates.length - approved.length;
      return NextResponse.json({
        ok: true,
        source: 'meta',
        imported: rows.length,
        note: `Imported ${rows.length} approved template${rows.length === 1 ? '' : 's'} from Meta${skipped ? ` (${skipped} not approved yet, skipped)` : ''}.`,
      });
    }
    // Meta was configured but refused: say so plainly rather than falling
    // through silently and blaming Interakt for a token problem.
    return NextResponse.json({
      ok: false,
      source: 'meta',
      error: `Meta refused: ${meta.error}`,
    }, { status: 502 });
  }

  // ---- 2. INTERAKT ---------------------------------------------------------
  const key = process.env.INTERAKT_API_KEY;
  if (!key) {
    return NextResponse.json({
      ok: false,
      error: 'Neither META_ACCESS_TOKEN nor INTERAKT_API_KEY is set.',
    }, { status: 503 });
  }

  const attempts: { url: string; init: RequestInit }[] = [
    { url: 'https://api.interakt.ai/v1/public/track/templates/', init: { method: 'GET' } },
    { url: 'https://api.interakt.ai/v1/public/track/templates/?limit=200&offset=0', init: { method: 'GET' } },
    { url: 'https://api.interakt.ai/v1/public/track/templates/', init: { method: 'POST', body: JSON.stringify({ limit: 200, offset: 0 }) } },
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

      if (!rows.length) return NextResponse.json({ ok: true, imported: 0, note: 'Interakt returned no approved templates.' });

      const err = await save(rows);
      if (err) return NextResponse.json({ ok: false, error: err }, { status: 500 });
      return NextResponse.json({ ok: true, source: 'interakt', imported: rows.length, note: `Imported ${rows.length} approved template(s).` });
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
        ? "Interakt's template list is broken on their side (HTTP 500 to every request; the same key sends messages fine). Add META_ACCESS_TOKEN to sync from Meta instead — that is the reliable route — or paste your templates in below."
        : `Interakt returned ${lastStatus}. Add META_ACCESS_TOKEN to sync from Meta, or paste your templates in below.`,
  }, { status: 502 });
}
