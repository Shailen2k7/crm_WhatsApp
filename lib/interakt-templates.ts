// =============================================================================
// FETCH TEMPLATES FROM INTERAKT — the endpoint their own dashboard uses.
// -----------------------------------------------------------------------------
// Interakt's PUBLIC templates API (/v1/public/track/templates/) has returned
// HTTP 500 to every request shape for months. Their dashboard does not use it:
// it calls the organization endpoint below, which works perfectly.
//
//   GET https://api.interakt.ai/v1/organizations/<org>/message-templates/v2/
//   Authorization: Token <session token>        <- note: "Token", not "Bearer"
//
// That header is the whole trick. "Basic <api key>" and "Bearer <token>" both
// return 401; "Token <token>" returns the full list with bodies, languages,
// categories and approval status.
//
// The session token is what identifies the Interakt user, so it is stored per
// workspace in relay_settings and can be refreshed from the Templates page
// whenever Interakt expires it.
// =============================================================================

export interface FetchedTemplate {
  name: string;
  language: string;
  category: string | null;
  status: string;
  body: string;
  variableCount: number;
}

const BASE = 'https://api.interakt.ai/v1/organizations';

/** Highest {{n}} in the body — how many values a send must supply. */
export function countVars(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

interface RawTemplate {
  name?: string;
  language?: string;
  category?: string;
  approval_status?: string;
  /** The approved wording. NOTE: `body_text` is the SAMPLE VALUES array, not
   *  the wording — reading that instead of `body` yields ["Prateek"]. */
  body?: string;
}

export async function fetchInteraktTemplates(
  orgId: string,
  sessionToken: string,
): Promise<{ ok: true; templates: FetchedTemplate[] } | { ok: false; error: string; expired?: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${orgId}/message-templates/v2/?limit=500`, {
      headers: { Authorization: `Token ${sessionToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach Interakt.' };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      expired: true,
      error: 'Interakt no longer accepts the saved connection — it has expired. Reconnect on this page to fix it.',
    };
  }
  if (!res.ok) return { ok: false, error: `Interakt returned HTTP ${res.status}.` };

  let json: { data?: RawTemplate[]; results?: RawTemplate[] };
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'Interakt sent a reply we could not read.' };
  }

  const list = json.data || json.results || [];
  const templates = list
    .filter((t) => t.name)
    .map((t) => {
      const body = t.body || '';
      return {
        name: t.name as string,
        language: t.language || 'en',
        category: t.category || null,
        status: (t.approval_status || '').toUpperCase(),
        body,
        variableCount: countVars(body),
      };
    });

  return { ok: true, templates };
}
