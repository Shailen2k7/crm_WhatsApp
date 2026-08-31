import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Public paths: the login/auth pages, plus (from Phase 2) the Interakt webhook,
// which authenticates with a shared secret rather than a user session.
const PUBLIC_PATHS = ['/login', '/auth/callback', '/api/whatsapp/webhook'];
const PLACEHOLDER_URL = 'https://placeholder.supabase.co';

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || PLACEHOLDER_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  if (url === PLACEHOLDER_URL) return response;

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  // Fail SOFT, exactly as the CRM does: auth middleware must never be able to
  // take the whole site down. A network blip during token refresh degrades to
  // "unauthenticated", and the (app) layout's server-side getUser() is the
  // real check regardless.
  let user: { id: string } | null = null;
  try {
    const { data } = await supabase.auth.getSession();
    user = data.session?.user ?? null;
  } catch {
    user = null;
  }

  if (!user && !isPublic) {
    // An API route must answer with a status its caller can read. Redirecting a
    // fetch() to an HTML login page turns "not signed in" into a JSON parse
    // error three layers away. Every /api route authenticates itself, so
    // middleware simply steps aside and lets it return a proper 401.
    if (path.startsWith('/api/')) return response;

    const u = request.nextUrl.clone();
    u.pathname = '/login';
    u.searchParams.set('next', path);
    return NextResponse.redirect(u);
  }
  if (user && path === '/login') {
    const u = request.nextUrl.clone();
    u.pathname = '/';
    return NextResponse.redirect(u);
  }
  return response;
}
