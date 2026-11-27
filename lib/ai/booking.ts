// =============================================================================
// CALL BOOKING — the assistant books on the same CRM booking page customers
// use (crm.migrizo.com/book/<slug>), through that page's own endpoints. So a
// call it books is a normal CRM meeting: same calendar rules, same email
// invite, same reminders. It never writes to the meetings table itself.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { linkedSignal } from '@/lib/automation/signals';

const CRM_BASE = (process.env.CRM_BASE_URL || 'https://crm.migrizo.com').replace(/\/$/, '');
const IST = 'Asia/Kolkata';

/** Where a number is from, when the country has one time zone worth quoting. */
const ZONE_BY_CODE: [string, string, string][] = [
  ['+91', IST, 'IST'], ['+44', 'Europe/London', 'UK time'], ['+971', 'Asia/Dubai', 'UAE time'],
  ['+65', 'Asia/Singapore', 'Singapore time'], ['+966', 'Asia/Riyadh', 'Saudi time'], ['+974', 'Asia/Qatar', 'Qatar time'],
  ['+968', 'Asia/Muscat', 'Oman time'], ['+965', 'Asia/Kuwait', 'Kuwait time'], ['+973', 'Asia/Bahrain', 'Bahrain time'],
  ['+49', 'Europe/Berlin', 'Germany time'], ['+33', 'Europe/Paris', 'France time'], ['+31', 'Europe/Amsterdam', 'Netherlands time'],
  ['+353', 'Europe/Dublin', 'Ireland time'], ['+60', 'Asia/Kuala_Lumpur', 'Malaysia time'], ['+977', 'Asia/Kathmandu', 'Nepal time'],
  ['+880', 'Asia/Dhaka', 'Bangladesh time'], ['+94', 'Asia/Colombo', 'Sri Lanka time'], ['+92', 'Asia/Karachi', 'Pakistan time'],
  ['+234', 'Africa/Lagos', 'Nigeria time'], ['+254', 'Africa/Nairobi', 'Kenya time'], ['+27', 'Africa/Johannesburg', 'South Africa time'],
  ['+64', 'Pacific/Auckland', 'New Zealand time'], ['+852', 'Asia/Hong_Kong', 'Hong Kong time'], ['+81', 'Asia/Tokyo', 'Japan time'],
];
export function zoneOfPhone(phoneE164: string): { tz: string; label: string } | null {
  const hit = ZONE_BY_CODE.filter(([c]) => phoneE164.startsWith(c)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? { tz: hit[1], label: hit[2] } : null;
}

const dayFmt = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });

/** "Sat, 29 Nov at 4:00 PM IST" (plus the customer's own time when abroad). */
export function describeSlot(iso: string, phoneE164: string): string {
  const d = new Date(iso);
  const base = `${dayFmt(IST).format(d)} at ${timeFmt(IST).format(d)} IST`;
  const z = zoneOfPhone(phoneE164);
  if (!z || z.tz === IST) return base;
  return `${base} (${dayFmt(z.tz).format(d)}, ${timeFmt(z.tz).format(d)} ${z.label})`;
}

export interface SlotList { slots: string[]; text: string; error: string | null }

/** Free slots for the next few days, as the booking page itself computes them. */
export async function freeSlots(slug: string, phoneE164: string, now: number, signal?: AbortSignal): Promise<SlotList> {
  const linked = linkedSignal([signal], 6_000);
  try {
    const from = new Date(now).toISOString().slice(0, 10);
    const to = new Date(now + 8 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(`${CRM_BASE}/api/booking/${encodeURIComponent(slug)}/slots?from=${from}&to=${to}`, {
      cache: 'no-store', signal: linked.signal,
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; slots?: string[] } | null;
    if (!res.ok || !j?.ok || !Array.isArray(j.slots)) return { slots: [], text: '', error: `booking page answered ${res.status}` };

    // The next five days that have anything free, at most 14 slots a day.
    const byDay = new Map<string, string[]>();
    for (const iso of j.slots) {
      if (new Date(iso).getTime() < now + 20 * 60_000) continue;
      const day = dayFmt(IST).format(new Date(iso));
      if (!byDay.has(day)) { if (byDay.size >= 5) break; byDay.set(day, []); }
      const list = byDay.get(day)!;
      if (list.length < 14) list.push(iso);
    }
    const slots = [...byDay.values()].flat();
    const text = slots.map((iso) => `[${iso}] ${describeSlot(iso, phoneE164)}`).join('\n');
    return { slots, text, error: null };
  } catch (e) {
    return { slots: [], text: '', error: e instanceof Error ? e.message : 'could not reach the booking page' };
  } finally {
    linked.done();
  }
}

export interface BookResult { ok: boolean; reason: string | null; meetLink: string | null }

export async function bookSlot(args: {
  slug: string; slot: string; name: string; email: string; phoneE164: string; signal?: AbortSignal;
}): Promise<BookResult> {
  try {
    const res = await fetch(`${CRM_BASE}/api/booking/${encodeURIComponent(args.slug)}/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      signal: args.signal ?? AbortSignal.timeout(12_000),
      body: JSON.stringify({
        startsAt: args.slot, name: args.name, email: args.email, phone: args.phoneE164,
        tz: zoneOfPhone(args.phoneE164)?.tz || IST, note: 'Booked on WhatsApp',
      }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string; meetLink?: string | null } | null;
    if (res.ok && j?.ok) return { ok: true, reason: null, meetLink: j.meetLink ?? null };
    return { ok: false, reason: j?.reason || `booking page answered ${res.status}`, meetLink: null };
  } catch (e) {
    // The request may have landed. The caller checks the calendar before it says anything.
    return { ok: false, reason: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network', meetLink: null };
  }
}

export async function rescheduleMeeting(args: { token: string; slot: string; signal?: AbortSignal }): Promise<BookResult> {
  try {
    const res = await fetch(`${CRM_BASE}/api/booking/manage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      signal: args.signal ?? AbortSignal.timeout(12_000),
      body: JSON.stringify({ token: args.token, action: 'reschedule', newStartsAt: args.slot }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;
    if (res.ok && j?.ok) return { ok: true, reason: null, meetLink: null };
    return { ok: false, reason: j?.reason || `booking page answered ${res.status}`, meetLink: null };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network', meetLink: null };
  }
}

export interface MeetingLite {
  id: string; starts_at: string; status: string; created_at: string; meet_link: string | null; manage_token: string | null;
}

/** This person's calls: by their lead, their WhatsApp number or their email. */
export async function meetingsFor(
  admin: SupabaseClient, ws: string, who: { leadId: string | null; phoneE164: string; email: string | null },
): Promise<MeetingLite[]> {
  const cols = 'id, starts_at, status, created_at, meet_link, manage_token';
  const last10 = who.phoneE164.replace(/\D/g, '').slice(-10);
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const queries = [
    who.leadId ? admin.from('meetings').select(cols).eq('workspace_id', ws).eq('lead_id', who.leadId).gte('created_at', since).limit(20) : null,
    last10.length === 10 ? admin.from('meetings').select(cols).eq('workspace_id', ws).ilike('client_phone', `%${last10}`).gte('created_at', since).limit(20) : null,
    who.email ? admin.from('meetings').select(cols).eq('workspace_id', ws).ilike('client_email', who.email).gte('created_at', since).limit(20) : null,
  ].filter(Boolean);
  const seen = new Map<string, MeetingLite>();
  for (const r of await Promise.all(queries)) {
    if (r!.error) throw new Error(`meetings: ${r!.error.message}`);
    for (const m of (r!.data || []) as MeetingLite[]) seen.set(m.id, m);
  }
  return [...seen.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
