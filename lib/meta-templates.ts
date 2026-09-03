// =============================================================================
// META TEMPLATE SYNC — the source of truth for approved templates.
// -----------------------------------------------------------------------------
// Interakt is our SENDING provider, but their template-list endpoint has
// returned HTTP 500 to every request shape for months (verified again today:
// the route exists, our key is valid — sending works — but listing is broken on
// their side). Meta owns the templates anyway, so we ask Meta directly.
//
// Needs one credential: META_ACCESS_TOKEN, a token with
// whatsapp_business_management. META_WABA_ID is optional — if it is missing we
// discover it from the token.
// =============================================================================

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface MetaTemplate {
  name: string;
  language: string;
  category: string | null;
  status: string;
  /** Approved BODY text, with {{1}} placeholders exactly as Meta stores it. */
  body: string;
  variableCount: number;
}

export function metaConfigured(): boolean {
  return !!process.env.META_ACCESS_TOKEN;
}

interface Component { type?: string; text?: string }
interface RawTemplate {
  name?: string; language?: string; category?: string; status?: string;
  components?: Component[];
}

/** Highest {{n}} in the body — how many values a send must supply. */
export function countVars(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

async function graph(path: string, token: string): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = (json as { error?: { message?: string } }).error;
      return { ok: false, error: e?.message || `Meta returned HTTP ${res.status}.` };
    }
    return { ok: true, json: json as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach Meta.' };
  }
}

/**
 * Find the WhatsApp Business Account id from the token alone, so the only
 * thing anyone has to paste is the token itself.
 */
export async function discoverWabaId(token: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const businesses = await graph('/me/businesses?limit=25', token);
  if (!businesses.ok) return { ok: false, error: businesses.error };

  const list = (businesses.json.data || []) as { id: string; name?: string }[];
  if (!list.length) return { ok: false, error: 'This token can see no Business accounts. It needs whatsapp_business_management.' };

  for (const biz of list) {
    const owned = await graph(`/${biz.id}/owned_whatsapp_business_accounts?limit=25`, token);
    if (!owned.ok) continue;
    const wabas = (owned.json.data || []) as { id: string }[];
    if (wabas.length) return { ok: true, id: wabas[0].id };

    // Templates can also live on a WABA merely shared with this business —
    // the usual arrangement when a BSP like Interakt onboarded the number.
    const shared = await graph(`/${biz.id}/client_whatsapp_business_accounts?limit=25`, token);
    if (shared.ok) {
      const s = (shared.json.data || []) as { id: string }[];
      if (s.length) return { ok: true, id: s[0].id };
    }
  }
  return { ok: false, error: 'No WhatsApp Business Account found for this token. Add META_WABA_ID explicitly.' };
}

/**
 * Every template on the account, approved ones first. Follows Meta's paging so
 * an account with hundreds still comes back complete.
 */
export async function fetchMetaTemplates(): Promise<
  { ok: true; templates: MetaTemplate[]; wabaId: string } | { ok: false; error: string }
> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'META_ACCESS_TOKEN is not set.' };

  let wabaId = process.env.META_WABA_ID || '';
  if (!wabaId) {
    const found = await discoverWabaId(token);
    if (!found.ok) return { ok: false, error: found.error };
    wabaId = found.id;
  }

  const out: MetaTemplate[] = [];
  let path: string | null = `/${wabaId}/message_templates?limit=100&fields=name,language,category,status,components`;

  // Bounded: 20 pages is 2000 templates, far past any real account.
  for (let page = 0; page < 20 && path; page++) {
    const res: Awaited<ReturnType<typeof graph>> = await graph(path, token);
    if (!res.ok) return { ok: false, error: res.error };

    for (const t of ((res.json.data || []) as RawTemplate[])) {
      if (!t.name) continue;
      const body = (t.components || []).find((c) => (c.type || '').toUpperCase() === 'BODY')?.text || '';
      out.push({
        name: t.name,
        language: t.language || 'en',
        category: t.category || null,
        status: (t.status || '').toUpperCase(),
        body,
        variableCount: countVars(body),
      });
    }

    const next = (res.json.paging as { next?: string } | undefined)?.next;
    // Re-derive the relative path; the absolute `next` already carries a token.
    path = next ? next.replace(GRAPH, '').replace(/([?&])access_token=[^&]*/, '$1').replace(/[?&]$/, '') : null;
  }

  return { ok: true, templates: out, wabaId };
}
