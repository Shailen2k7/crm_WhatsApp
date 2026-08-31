// Diagnostics for Phase 2 setup. Reports what is configured and whether the
// database tables exist — without leaking a single secret value.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const admin = createAdminClient();
  let tables = { conversations: false, messages: false };
  if (admin) {
    const [c, m] = await Promise.all([
      admin.from('relay_conversations').select('id').limit(1),
      admin.from('relay_messages').select('id').limit(1),
    ]);
    tables = { conversations: !c.error, messages: !m.error };
  }

  return NextResponse.json({
    ok: true,
    config: {
      supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      interaktApiKey: !!process.env.INTERAKT_API_KEY,
      interaktWebhookSecret: !!process.env.INTERAKT_WEBHOOK_SECRET,
    },
    tables,
    migrationNeeded: !tables.conversations || !tables.messages,
  });
}
