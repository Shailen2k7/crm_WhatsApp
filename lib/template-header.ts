// =============================================================================
// TEMPLATE HEADER DOCUMENTS
// -----------------------------------------------------------------------------
// Some approved templates (gtv_e1) were approved with a DOCUMENT header — the
// GTV PDF rides on top of the message. Meta will not send such a template
// without a link to the file, and Interakt answers "Media Url is missing for
// header's document". Every gtv_e1 ever sent from Relay failed that way.
//
// The file lives in our private bucket at
//   template-headers/<template name, lower case>/<File name.pdf>
// One file per folder. Its name is the name the customer sees, so swapping the
// PDF is a matter of replacing that one file — no code change.
// =============================================================================
// No runtime imports: the Files panel (a client component) uses the path
// helpers below, and lib/files pulls in next/server.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface HeaderDoc { path: string; name: string; mime: string; size: number }

export const TEMPLATE_HEADER_ROOT = 'template-headers';

/** True for a template's permanent PDF. Nothing in the app may delete these. */
export function isTemplateHeaderPath(path: string | null | undefined): boolean {
  return !!path && path.startsWith(`${TEMPLATE_HEADER_ROOT}/`);
}

/** "template-headers/gtv_e1/GTV.pdf" → "gtv_e1". */
export function templateOfHeaderPath(path: string | null | undefined): string | null {
  if (!isTemplateHeaderPath(path)) return null;
  return (path as string).split('/')[1] || null;
}

/** The header PDF registered for this template, or null when it has none. */
export async function templateHeaderDoc(admin: SupabaseClient, bucket: string, templateName: string): Promise<HeaderDoc | null> {
  const folder = `${TEMPLATE_HEADER_ROOT}/${templateName.toLowerCase()}`;
  const { data, error } = await admin.storage.from(bucket).list(folder, { limit: 10 });
  if (error || !data) return null;
  const file = data.find((f) => f.id && f.name && !f.name.startsWith('.'));
  if (!file) return null;
  const meta = (file.metadata || {}) as { mimetype?: string; size?: number };
  return {
    path: `${folder}/${file.name}`,
    name: file.name,
    mime: meta.mimetype || 'application/pdf',
    size: meta.size || 0,
  };
}
