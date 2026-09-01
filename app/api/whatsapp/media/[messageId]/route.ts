// =============================================================================
// MEDIA — serves a message's file to a signed-in member of its workspace.
// GET /api/whatsapp/media/<messageId>          -> inline (image preview)
// GET /api/whatsapp/media/<messageId>?download -> attachment (Save as…)
//
// Private bucket, so this route IS the access control: session first, then a
// workspace check, and only then are bytes read — fully into a Buffer with an
// explicit Content-Length (see lib/files.ts for the 0-byte-download war story).
// Falls back to Interakt's CDN url if our archive copy is missing.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { RELAY_BUCKET, toBuffer, safeFilename, mimeFor, fileResponse } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await ctx.params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ ok: false, error: 'No membership.' }, { status: 403 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Not configured.' }, { status: 500 });

  const { data: msg } = await admin
    .from('relay_messages')
    .select('id, workspace_id, media_path, media_url, media_name, media_mime')
    .eq('id', messageId)
    .maybeSingle();

  if (!msg || msg.workspace_id !== member.workspace_id) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }
  if (!msg.media_path && !msg.media_url) {
    return NextResponse.json({ ok: false, error: 'This message has no file.' }, { status: 404 });
  }

  const download = new URL(req.url).searchParams.has('download');

  // Our archived copy first — permanent and private.
  if (msg.media_path) {
    const { data: blob, error } = await admin.storage.from(RELAY_BUCKET).download(msg.media_path);
    if (!error && blob) {
      const buf = await toBuffer(blob);
      if (buf.length > 0) {
        const { filename, ext } = safeFilename({ name: msg.media_name, path: msg.media_path, mime: msg.media_mime, buf });
        return fileResponse(buf, filename, mimeFor(ext, msg.media_mime), download);
      }
    }
  }

  // Fallback: the provider CDN link (may have expired — be honest if so).
  if (msg.media_url) {
    try {
      const res = await fetch(msg.media_url, { signal: AbortSignal.timeout(25_000) });
      if (res.ok) {
        const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
        if (buf.length > 0) {
          const { filename, ext } = safeFilename({ name: msg.media_name, mime: res.headers.get('content-type'), buf });
          return fileResponse(buf, filename, mimeFor(ext, res.headers.get('content-type')), download);
        }
      }
    } catch { /* fall through */ }
  }

  return NextResponse.json(
    { ok: false, error: 'The file could not be retrieved — the provider link may have expired before it was archived.' },
    { status: 502 }
  );
}
