// =============================================================================
// LIVE TEMPLATES — the approved list, straight from Interakt.
// -----------------------------------------------------------------------------
// Interakt's PUBLIC API lists templates with nothing but the API key the app
// already sends with:
//
//   GET https://api.interakt.ai/v1/public/track/organization/templates
//       ?offset=0&language=all&approval_status=APPROVED
//   Authorization: Basic <INTERAKT_API_KEY>
//
// (Verified 14 Nov 2026: 71 approved templates in one answer, with the wording,
// the header kind and the header file. Do NOT add `autosubmitted_for=…` — with
// it the list comes back empty.)
//
// So a template approved five minutes ago shows up in the Broadcast page with
// one press of Refresh — no session token, no copy-paste. What comes back is
// also saved to relay_templates, so the chat thread can show the real wording.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { countVars, type LiveTemplate, type TemplateHeader } from './model';

const BASE = 'https://api.interakt.ai/v1/public/track/organization/templates';

interface RawTemplate {
  name?: string; language?: string; category?: string | null; body?: string | null; footer?: string | null;
  header_format?: string | null; header?: string | null;
  header_handle_file_url?: string | null; header_handle_file_name?: string | null;
  buttons?: unknown; approval_status?: string; created_at_utc?: string | null;
}

/** Button captions out of whatever shape Interakt sends ("{}", a JSON string, an object, a list). */
function buttonLabels(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  const out: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (!x || depth > 4) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.text === 'string' && o.text.trim()) out.push(o.text.trim());
      for (const k of Object.keys(o)) if (typeof o[k] === 'object') walk(o[k], depth + 1);
    }
  };
  walk(v, 0);
  return out.slice(0, 10);
}

/** True when a button needs a per-person value (a {{1}} in its link). */
function buttonsNeedValues(raw: unknown): boolean {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return /\{\{\s*\d+\s*\}\}/.test(s);
}

function shape(t: RawTemplate): LiveTemplate | null {
  const name = (t.name || '').trim();
  if (!name) return null;
  const body = t.body || '';
  const format = (t.header_format || '').toUpperCase();
  const header: TemplateHeader | null = format
    ? { format, url: t.header_handle_file_url || null, fileName: t.header_handle_file_name || null }
    : null;
  let blocked: string | null = null;
  if (format === 'TEXT' && /\{\{\s*\d+\s*\}\}/.test(t.header || '')) blocked = 'Its heading has a blank to fill, which a broadcast cannot do yet.';
  else if (buttonsNeedValues(t.buttons)) blocked = 'One of its buttons needs a different link per person, which a broadcast cannot do yet.';
  else if (format === 'LOCATION') blocked = 'It has a location header, which a broadcast cannot send.';
  return {
    name, language: t.language || 'en', category: t.category || null, body,
    footer: t.footer || null, variableCount: countVars(body), header,
    buttons: buttonLabels(t.buttons), createdAt: t.created_at_utc || null, blocked,
  };
}

export async function fetchLiveTemplates(): Promise<{ ok: true; templates: LiveTemplate[] } | { ok: false; error: string }> {
  const key = process.env.INTERAKT_API_KEY;
  if (!key) return { ok: false, error: 'WhatsApp is not connected — INTERAKT_API_KEY is not set.' };
  const out: LiveTemplate[] = [];
  let offset = 0;
  try {
    for (let page = 0; page < 20; page++) {
      const res = await fetch(`${BASE}?offset=${offset}&language=all&approval_status=APPROVED`, {
        headers: { Authorization: `Basic ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
      if (!res.ok) return { ok: false, error: `Interakt answered HTTP ${res.status} when asked for the template list.` };
      const j = (await res.json()) as { has_next?: boolean; results?: { templates?: RawTemplate[] } };
      const batch = j.results?.templates || [];
      for (const t of batch) {
        if ((t.approval_status || '').toUpperCase() !== 'APPROVED') continue;
        const s = shape(t);
        if (s) out.push(s);
      }
      if (!j.has_next || !batch.length) break;
      offset += batch.length;
    }
  } catch {
    return { ok: false, error: 'Could not reach Interakt for the template list. Try again in a moment.' };
  }
  // Newest first: the one just approved is the one being looked for.
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { ok: true, templates: out };
}

/**
 * Adds templates the app has not seen before to relay_templates, so the chat
 * composer offers them too. NEW ONES ONLY: a template already registered keeps
 * its saved wording — some were tidied by hand (the *bold* marks removed) and
 * a refresh must never undo that.
 */
export async function rememberTemplates(admin: SupabaseClient, ws: string, templates: LiveTemplate[]): Promise<void> {
  if (!templates.length) return;
  const now = new Date().toISOString();
  const rows = templates.filter((t) => t.body).map((t) => ({
    workspace_id: ws, name: t.name, language: t.language, body: t.body,
    category: t.category, variable_count: t.variableCount, updated_at: now,
  }));
  if (rows.length) {
    await admin.from('relay_templates').upsert(rows, { onConflict: 'workspace_id,name,language', ignoreDuplicates: true });
  }
}

/** The saved list, for when Interakt cannot be reached: enough to keep working. */
export async function savedTemplates(admin: SupabaseClient, ws: string): Promise<LiveTemplate[]> {
  const { data } = await admin.from('relay_templates')
    .select('name, language, category, body, variable_count, created_at')
    .eq('workspace_id', ws).order('created_at', { ascending: false }).limit(500);
  return ((data || []) as { name: string; language: string | null; category: string | null; body: string | null; created_at: string | null }[])
    .map((t) => ({
      name: t.name, language: t.language || 'en', category: t.category, body: t.body || '', footer: null,
      variableCount: countVars(t.body || ''), header: null, buttons: [], createdAt: t.created_at, blocked: null,
    }));
}
