// =============================================================================
// FILE SERVING — the one place that turns stored bytes into an HTTP body.
// -----------------------------------------------------------------------------
// Ported from the CRM's lib/files/serve.ts, which exists because of a real
// production incident: downloads arriving as 0-byte files. The cause was
// handing a stream-backed Blob to NextResponse on a serverless runtime that
// closed before draining it. The fix is boring and total: always read fully
// into a Buffer, assert the length, send an explicit Content-Length.
//
// The founder's rule carried over with it: the customer's own filename is kept
// exactly as they sent it — but it MUST end in a real extension or nothing
// opens it, so when the name has none we sniff the actual bytes.
// =============================================================================
import { NextResponse } from 'next/server';

export const RELAY_BUCKET = 'relay-media';

/** WhatsApp's own cap for documents is 100MB, but 16MB covers every CV and
 * passport scan and keeps serverless memory sane. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export async function toBuffer(file: Blob | ArrayBuffer | Uint8Array): Promise<Buffer> {
  if (Buffer.isBuffer(file)) return file;
  if (file instanceof Uint8Array) return Buffer.from(file);
  if (file instanceof ArrayBuffer) return Buffer.from(new Uint8Array(file));
  const ab = await (file as Blob).arrayBuffer();
  return Buffer.from(new Uint8Array(ab));
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/rtf': 'rtf', 'application/rtf': 'rtf',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([m, e]) => [e, m])
);
EXT_MIME['jpeg'] = 'image/jpeg';

/** Magic-byte sniffing — definitive when the filename lies or has no extension. */
export function sniffExt(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.length > 11 && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'doc';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'docx';
  if (b.length > 11 && b.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';
  return null;
}

export function safeFilename(opts: {
  name?: string | null; path?: string | null; mime?: string | null; buf?: Buffer | null;
  fallback?: string;
}): { filename: string; ext: string } {
  const raw = (opts.name || '').replace(/[\r\n"\\]/g, '').replace(/[/\\]/g, '-').trim();
  const base = raw || (opts.fallback || 'file');

  const existing = /\.(\w{2,5})$/.exec(base);
  if (existing && existing[1].toLowerCase() !== 'bin') {
    return { filename: base, ext: existing[1].toLowerCase() };
  }

  const fromBytes = opts.buf ? sniffExt(opts.buf) : null;
  const fromPath = (opts.path || '').split('.').pop()?.toLowerCase();
  const fromMime = MIME_EXT[(opts.mime || '').split(';')[0].trim().toLowerCase()];
  const ext = fromBytes
    || (fromPath && /^\w{2,5}$/.test(fromPath) && fromPath !== 'bin' ? fromPath : null)
    || fromMime
    || 'pdf';

  return { filename: `${base.replace(/\.bin$/i, '')}.${ext}`, ext };
}

export function mimeFor(ext: string, declared?: string | null): string {
  const d = (declared || '').split(';')[0].trim().toLowerCase();
  const byExt = EXT_MIME[ext];
  if (byExt && (!d || d === 'application/octet-stream' || d === 'binary/octet-stream')) return byExt;
  return d || byExt || 'application/octet-stream';
}

/** Non-ASCII names (Hindi, accents) go out twice: stripped ASCII for old
 * clients, RFC 5987 for real ones. */
export function fileResponse(
  buf: Buffer, filename: string, contentType: string, download: boolean
): NextResponse {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(filename);
  const body = new Uint8Array(buf.byteLength);
  body.set(buf);
  return new NextResponse(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.byteLength),
      'Content-Disposition':
        `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * A presentable name for an inbound file whose only identity is a CDN hash.
 * "HbvMvkhxttDr.pdf" is what Interakt's storage calls it; nobody at Migrizo
 * should have to read that. A name is kept only if it looks like one a human
 * chose (spaces, separators, or a real word-like stem); otherwise it becomes
 * "Migrizo Document 2026-09-01 18.09.pdf", timestamped so ten photos from one
 * afternoon stay distinguishable.
 */
export function presentableName(rawName: string, mediaType: string | null, when: Date = new Date()): string {
  const ext = (/\.(\w{2,5})$/.exec(rawName)?.[1] || 'bin').toLowerCase();
  const stem = rawName.replace(/\.\w{2,5}$/, '');
  const humanish =
    /[ _\-()]/.test(stem) ||                       // separators = a chosen name
    (stem.length <= 24 && /^[a-z0-9]+$/i.test(stem) && !/[a-z][A-Z]/.test(stem) && stem.length <= 12);
  if (humanish && stem.length > 0) return rawName;

  const kind =
    mediaType === 'image' ? 'Photo'
    : mediaType === 'audio' ? 'Audio'
    : mediaType === 'video' ? 'Video'
    : 'Document';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}`;
  return `Migrizo ${kind} ${stamp}.${ext}`;
}

/** Storage path for a message's media: workspace/conversation/message-name.
 * The folder structure is what makes deleting a whole conversation's files a
 * single prefix listing later. */
export function mediaPath(workspaceId: string, conversationId: string, messageId: string, filename: string): string {
  const clean = filename.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  return `${workspaceId}/${conversationId}/${messageId}-${clean}`;
}
