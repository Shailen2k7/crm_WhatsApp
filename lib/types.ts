// =============================================================================
// Types mirroring the Migrizo CRM schema. Relay reads the SAME Postgres tables,
// so these must stay in step with the CRM's lib/types.ts. Only the fields Relay
// actually uses are declared — a narrower type is safer than a stale wide one.
// =============================================================================

export type LeadStage =
  | 'hot'
  | 'cold'
  | 'not_responding'
  | 'mr_coming_soon'
  | 'invoice_sent'
  | 'won'
  | 'junk';

export interface Lead {
  id: string;
  workspace_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  visa_type: string | null;
  stage: LeadStage;
  source: string | null;
  owner_id: string | null;
  industry: string | null;
  tags: string[] | null;
  next_follow_up: string | null;
  last_note: string | null;
  last_note_at: string | null;
  first_response_at: string | null;
  cv_path: string | null;
  cv_name: string | null;
  created_at: string;
  updated_at: string;
  is_sample: boolean | null;
}

export interface RelayUser {
  id: string;
  email: string;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
}

// --- display meta, matched to the CRM so a stage reads the same in both -------

export const STAGE_META: Record<LeadStage, { label: string; bg: string; fg: string; dot: string }> = {
  hot: { label: 'Hot', bg: '#FEE2E2', fg: '#B91C1C', dot: '#EF4444' },
  cold: { label: 'Cold', bg: '#DBEAFE', fg: '#1E40AF', dot: '#3B82F6' },
  not_responding: { label: 'Not Responding', bg: '#FFF3EA', fg: '#9A3412', dot: '#EA580C' },
  mr_coming_soon: { label: 'Mr. Coming Soon', bg: '#FEF3C7', fg: '#B45309', dot: '#F59E0B' },
  invoice_sent: { label: 'Invoice Sent', bg: '#EDE9FE', fg: '#5B21B6', dot: '#7C3AED' },
  won: { label: 'Won', bg: '#E6F7EE', fg: '#047857', dot: '#10B981' },
  junk: { label: 'Junk', bg: '#F4F4F6', fg: '#6B7280', dot: '#9CA3AF' },
};

/** Never throws on a stage the CRM added after this file was written. */
export function getStageMeta(stage: string | null | undefined) {
  if (stage && stage in STAGE_META) return STAGE_META[stage as LeadStage];
  return { label: stage ? String(stage) : 'Unknown', bg: '#F4F4F6', fg: '#6B7280', dot: '#9CA3AF' };
}

export type VisaType = 'gtv' | 'ifv';

export const VISA_META: Record<VisaType, { short: string; full: string; bg: string; fg: string }> = {
  gtv: { short: 'GTV', full: 'Global Talent Visa', bg: '#EEF2FF', fg: '#4338CA' },
  ifv: { short: 'IFV', full: 'Innovator Founder Visa', bg: '#ECFEFF', fg: '#0E7490' },
};

/** Resolves clean codes AND the legacy free-text the CRM still holds. */
export function getVisaMeta(v: string | null | undefined) {
  if (!v) return null;
  const k = v.toLowerCase().trim();
  if (k === 'gtv' || k === 'ifv') return VISA_META[k as VisaType];
  if (k.includes('global') || k.includes('talent') || k.includes('gtv')) return VISA_META.gtv;
  if (k.includes('innovator') || k.includes('founder') || k.includes('ifv')) return VISA_META.ifv;
  return null;
}
