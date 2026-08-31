import { createBrowserClient } from '@supabase/ssr';

// =============================================================================
// The browser's Supabase client.
// -----------------------------------------------------------------------------
// WHY THIS FILE VALIDATES ITS OWN CONFIG
//
// A misconfigured URL or key does not fail in a way anyone can read. The browser
// simply cannot complete the request, and `fetch` rejects with a bare TypeError
// — "Failed to fetch" in Chrome, the famously useless "Type error" in Safari.
// That message is three layers away from the actual cause, which is always one
// of a very small number of things.
//
// So we check the config BEFORE using it and say precisely what is wrong. The
// real-world case that cost hours: an anon key pasted from a UI that was
// displaying it masked, so the deployed value was 8 real characters followed by
// 200 bullet characters. It looked present. It was the right length. It was
// nonsense, and nothing said so.
// =============================================================================

export interface ConfigProblem {
  field: 'url' | 'key';
  message: string;
}

/** Characters used by UIs to mask a secret. None of them are legal in a URL or a JWT. */
const MASK_CHARS = /[•·▪●*•·●∙]/;

/**
 * Returns a description of what is wrong with the config, or null if it is
 * usable. Pure and synchronous, so both the client factory and the login screen
 * can call it without side effects.
 */
export function checkConfig(url: string | undefined, key: string | undefined): ConfigProblem | null {
  if (!url) {
    return { field: 'url', message: 'NEXT_PUBLIC_SUPABASE_URL is not set on this deployment.' };
  }
  if (url.includes('placeholder')) {
    return { field: 'url', message: 'NEXT_PUBLIC_SUPABASE_URL is not set — the app fell back to a placeholder.' };
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url.trim())) {
    return {
      field: 'url',
      message: `NEXT_PUBLIC_SUPABASE_URL looks wrong: "${url}". It should look like https://xxxx.supabase.co (note .co, not .com).`,
    };
  }

  if (!key) {
    return { field: 'key', message: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on this deployment.' };
  }
  if (key.includes('placeholder')) {
    return { field: 'key', message: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set — the app fell back to a placeholder.' };
  }
  if (MASK_CHARS.test(key)) {
    return {
      field: 'key',
      message:
        'NEXT_PUBLIC_SUPABASE_ANON_KEY contains masking characters (•). The value was copied from a screen that was hiding it. Re-copy the real key from Supabase → Project Settings → API.',
    };
  }
  // A JWT is three base64url segments separated by dots. Anything else cannot work.
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return {
      field: 'key',
      message: `NEXT_PUBLIC_SUPABASE_ANON_KEY is not a valid JWT (expected 3 dot-separated parts, got ${parts.length}). Re-copy it from Supabase → Project Settings → API.`,
    };
  }
  // Decode the payload and confirm it is the ANON key for THIS project.
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role && payload.role !== 'anon') {
      return {
        field: 'key',
        message: `NEXT_PUBLIC_SUPABASE_ANON_KEY holds a "${payload.role}" key, not the anon key. Never put the service role key in a NEXT_PUBLIC_ variable.`,
      };
    }
    const ref = payload.ref as string | undefined;
    if (ref && !url.includes(ref)) {
      return {
        field: 'key',
        message: `The anon key belongs to project "${ref}" but the URL points at a different project. They must match.`,
      };
    }
  } catch {
    return { field: 'key', message: 'NEXT_PUBLIC_SUPABASE_ANON_KEY could not be decoded. Re-copy it from Supabase → Project Settings → API.' };
  }

  return null;
}

export function getConfig() {
  return {
    url: (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim(),
    key: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim(),
  };
}

/** The config problem, if any — for the login screen to render. */
export function configProblem(): ConfigProblem | null {
  const { url, key } = getConfig();
  return checkConfig(url, key);
}

export function createClient() {
  const { url, key } = getConfig();

  const problem = checkConfig(url, key);
  if (problem && typeof window !== 'undefined') {
    console.error('[Relay] Supabase config problem:', problem.message);
  }

  // Still construct a client even when the config is bad: the login screen
  // renders the precise reason, and a thrown error here would blank the page
  // and hide it.
  return createBrowserClient(url || 'https://placeholder.supabase.co', key || 'placeholder-anon-key');
}
