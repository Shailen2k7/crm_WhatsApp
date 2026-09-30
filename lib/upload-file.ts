// =============================================================================
// UPLOAD ONE FILE — for a chat message or a quick reply.
// -----------------------------------------------------------------------------
// Both the composer and the quick-replies editor attach files the same way:
// post the file to /api/whatsapp/upload, get back where it was stored. This is
// that one step, shared, so the two can never drift apart.
//
// It resolves with the stored attachment, or THROWS with the server's own
// reason ("File is larger than 16MB — WhatsApp will reject it.") so the caller
// can show exactly why a file did not go — never a blanket "could not upload".
// =============================================================================

export interface UploadedFile {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  const fd = new FormData();
  fd.append('file', file);

  let res: Response;
  try {
    res = await fetch('/api/whatsapp/upload', { method: 'POST', body: fd });
  } catch {
    throw new Error('network error — check the connection and try again');
  }

  // A proxy or platform error page is HTML, not JSON: keep the status code as
  // the reason rather than failing on the parse.
  let json: { ok?: boolean; error?: string; attachment?: UploadedFile } = {};
  try { json = await res.json(); } catch { /* not JSON */ }

  if (!res.ok || !json.ok || !json.attachment) {
    throw new Error(
      json.error ||
      (res.status === 413 ? 'the file is too large to upload' : `upload failed (HTTP ${res.status})`),
    );
  }
  return json.attachment;
}
