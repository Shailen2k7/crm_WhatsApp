// =============================================================================
// UPLOAD — an agent attaches a file (composer or quick-reply builder).
// Stores it in the private bucket and returns {path,name,mime,size}, which the
// send route or quick-reply row then references. Nothing is sent from here.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { RELAY_BUCKET, MAX_UPLOAD_BYTES, toBuffer, safeFilename, mimeFor } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'No file.' }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'File is larger than 16MB — WhatsApp will reject it.' }, { status: 413 });
  }
  if (file.size === 0) return NextResponse.json({ ok: false, error: 'The file is empty.' }, { status: 400 });

  const buf = await toBuffer(file);
  // The user's own filename survives exactly; only an extension is added if missing.
  const { filename, ext } = safeFilename({ name: file.name, mime: file.type, buf, fallback: 'attachment' });
  const mime = mimeFor(ext, file.type);

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 });

  // Uploads live under an /uploads prefix until a message claims them.
  const path = `${member.workspace_id}/uploads/${crypto.randomUUID()}-${filename.replace(/[^\w.\- ()]/g, '_').slice(0, 120)}`;
  const { error } = await admin.storage.from(RELAY_BUCKET).upload(path, buf, { contentType: mime, upsert: false });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, attachment: { path, name: filename, mime, size: buf.byteLength } });
}
