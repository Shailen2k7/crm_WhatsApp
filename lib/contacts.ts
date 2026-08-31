// =============================================================================
// THE MERGED LIST — what actually belongs in a WhatsApp inbox.
// -----------------------------------------------------------------------------
// Relay draws from two sources that only partly overlap:
//
//   leads          — everyone in the CRM with a phone number. Most have never
//                    been messaged.
//   conversations  — every WhatsApp thread. Some belong to a lead; some do not,
//                    because a stranger can message the business at any time.
//
// The first version of this list rendered ONLY leads, which meant an inbound
// message from someone not yet in the CRM was stored correctly and then never
// shown to anybody. That is the worst kind of bug in a messaging app: silent.
//
// So the unit of the list is a Contact — a lead, a conversation, or both fused
// on phone number. A thread always appears, whether or not the CRM knows who it
// is, and an unknown number is labelled as such rather than hidden.
// =============================================================================
import type { Lead } from './types';
import type { RelayConversation } from './messages';
import { toE164, matchKey } from './phone';

export interface Contact {
  /** Stable React key: the lead id when known, else the conversation id. */
  key: string;
  leadId: string | null;
  conversationId: string | null;
  /** Display name — the lead's name, or the phone number for an unknown. */
  name: string;
  phoneE164: string | null;
  /** Raw phone as stored on the lead, for the send API. */
  phoneRaw: string | null;
  lead: Lead | null;
  conversation: RelayConversation | null;
  unread: number;
  lastMessageAt: string | null;
  lastPreview: string | null;
  lastDirection: 'in' | 'out' | null;
  /** True when a thread exists but no CRM record does. */
  unknown: boolean;
}

/**
 * Fuses leads and conversations into one ordered list.
 *
 * Ordering, in the order a human would want it:
 *   1. Conversations with real activity, newest message first.
 *   2. Everyone else (leads never messaged), by most recently updated.
 *
 * A lead and a conversation are the same person when the LAST 10 DIGITS of
 * their numbers match — the CRM's own rule, because the same person has
 * arrived as "+919812345678", "919812345678" and "p:+91 98123 45678".
 */
export function mergeContacts(leads: Lead[], conversations: RelayConversation[]): Contact[] {
  // Index conversations by their match key so each lead can find its thread.
  const convByKey = new Map<string, RelayConversation>();
  for (const c of conversations) {
    const k = matchKey(c.phone_e164);
    if (k) convByKey.set(k, c);
  }

  const usedConvIds = new Set<string>();
  const out: Contact[] = [];

  for (const lead of leads) {
    const k = matchKey(lead.phone);
    const conv = k ? convByKey.get(k) ?? null : null;
    if (conv) usedConvIds.add(conv.id);

    out.push({
      key: lead.id,
      leadId: lead.id,
      conversationId: conv?.id ?? null,
      name: lead.full_name,
      phoneE164: toE164(lead.phone),
      phoneRaw: lead.phone,
      lead,
      conversation: conv,
      unread: conv?.unread_count ?? 0,
      lastMessageAt: conv?.last_message_at ?? null,
      lastPreview: conv?.last_preview ?? null,
      lastDirection: conv?.last_direction ?? null,
      unknown: false,
    });
  }

  // Threads with nobody in the CRM behind them. These are the ones the old
  // list dropped on the floor.
  for (const conv of conversations) {
    if (usedConvIds.has(conv.id)) continue;
    out.push({
      key: conv.id,
      leadId: null,
      conversationId: conv.id,
      name: conv.phone_e164,
      phoneE164: conv.phone_e164,
      phoneRaw: conv.phone_e164,
      lead: null,
      conversation: conv,
      unread: conv.unread_count ?? 0,
      lastMessageAt: conv.last_message_at,
      lastPreview: conv.last_preview,
      lastDirection: conv.last_direction,
      unknown: true,
    });
  }

  return out.sort((a, b) => {
    // Anything with a message outranks anything without one.
    if (a.lastMessageAt && !b.lastMessageAt) return -1;
    if (!a.lastMessageAt && b.lastMessageAt) return 1;
    if (a.lastMessageAt && b.lastMessageAt) {
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    }
    const au = a.lead?.updated_at || '';
    const bu = b.lead?.updated_at || '';
    return bu.localeCompare(au);
  });
}
