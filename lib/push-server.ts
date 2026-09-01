// =============================================================================
// SERVER-SIDE PUSH — reach the team's phones and desktops.
// Mirrors the CRM's push discipline exactly (it shares the same
// push_subscriptions table): VAPID from env, dead subscriptions pruned on the
// spot (404/410), and it NEVER throws — a push failure must not affect the
// message that triggered it.
// =============================================================================
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

let configured: boolean | null = null;
function configure(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { configured = false; return false; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@migrizo.com', pub, priv);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function pushToWorkspace(
  admin: SupabaseClient,
  workspaceId: string,
  payload: PushPayload
): Promise<number> {
  try {
    if (!configure()) return 0;
    const { data: subs } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('workspace_id', workspaceId);
    if (!subs?.length) return 0;

    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await admin.from('push_subscriptions').delete().eq('id', s.id);
        }
      }
    }));
    return sent;
  } catch (e) {
    console.error('[relay push] failed', e);
    return 0;
  }
}
