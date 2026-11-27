// =============================================================================
// THE ASSISTANT'S RUN — every minute: answer the chats that are waiting.
// -----------------------------------------------------------------------------
// For each chat whose last message is the customer's and that nobody has
// answered, it reads the chat, asks the brain for the next step, checks that
// step against the rules, and then does it: send a reply, give the verdict with
// the team's saved replies and brochure, book the call on the CRM calendar — or
// stop and call a human.
//
// THE RULES THAT KEEP IT SAFE
//   * Off unless the switch is on, and it only answers messages that arrived
//     after the switch was turned on.
//   * It waits 45 seconds after the customer's last message, so a burst of
//     messages is answered once, not five times.
//   * It keeps out of a chat while a teammate is typing there (10 minutes
//     after any human message), and for good once it has handed the chat over,
//     until a human gives it back or 12 hours pass after their last reply.
//   * Won clients, anyone who said STOP, and the ad-form message of a brand new
//     lead (T1's job) are left alone.
//   * Every message is saved in the chat BEFORE it is sent, and a step whose
//     outcome is unknown is never sent again. A chat is tried three times at
//     most; then it goes to a human.
//   * Whenever it is not sure, it sends nothing and notifies the team.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendMedia, sendText, mediaTypeFrom } from '@/lib/interakt';
import { RELAY_BUCKET } from '@/lib/files';
import { extractCv } from '@/lib/cv-extract';
import { pushToWorkspace } from '@/lib/push-server';
import { sendTemplateToLead, firstNameOf } from '@/lib/send-template';
import { CALL_TIMEOUT_MS, type RunContext } from '@/lib/automation/run-context';
import { ecosystemStatesByConv, heldByEcosystem } from '@/lib/automation/ecosystem';
import {
  bookSlot, describeSlot, freeSlots, meetingsFor, rescheduleMeeting,
  type BookResult, type MeetingLite, type SlotList,
} from './booking';
import {
  checkDecision, isAiMessage, think as realThink,
  type ChatContext, type ChatFile, type ChatMessage, type Checked, type LeadFacts, type Thinker,
} from './brain';
import {
  loadConfig, loadIndex, loadState, loadStates, record, saveIndex, saveState,
  type AiConfig, type AiIndex, type AiState, type PlanStep, type Verdict,
} from './store';

export const AI_BUDGET = { stopStartingAfterMs: 15_000, hardStopMs: 23_000 } as const;
const DEBOUNCE_MS = 45_000;
const HUMAN_ACTIVE_MS = 10 * 60_000;
const WINDOW_SAFE_MS = 23.5 * 3_600_000;
const NEW_LEAD_WAIT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_DECISIONS_PER_RUN = 3;
const START_DECISIONS_BEFORE_MS = 5_000;
const THINK_TIMEOUT_MS = 16_000;
const HOLD_RELEASE_MS = 12 * 3_600_000;
const HOLD_EXPIRE_MS = 14 * 86_400_000;
const FOLLOW_UP_GAPS_MS = [2 * 86_400_000, 86_400_000, 86_400_000];
const FOLLOW_UP_TEMPLATES = ['cbr1', 'cbr2', 'cbr3'];
const CROSS_ENGINE_GAP_MS = 20 * 3_600_000;
/** Stages the assistant never writes to: the team's own clients. */
const CLIENT_STAGES = new Set(['won', 'invoice_sent']);
const CLOSED_STAGES = new Set(['won', 'invoice_sent', 'junk', 'lost']);

/** The saved replies each verdict sends, in order. The team's own wording and brochures. */
const VERDICT_REPLIES: Record<Verdict, string[]> = {
  gtv: ['gtveligible1', 'gtveligible2'],
  gtv_high: ['gtveligible1', 'gtveligible2'],
  not: ['noneligiblegtv', 'noneligiblegtv2'],
  ifv: ['ifveligible', 'noneligiblegtv2'],
};
const VERDICT_LABEL: Record<Verdict, string> = {
  gtv: 'Eligible for the Global Talent Visa',
  gtv_high: 'Highly eligible for the Global Talent Visa',
  not: 'Not eligible for the Global Talent Visa (Innovator Founder Visa offered)',
  ifv: 'Eligible to explore the Innovator Founder Visa',
};

type Admin = SupabaseClient;
const MSG_COLS = 'id, direction, body, created_at, template_name, template_values, sent_by, is_internal, status, media_type, media_name, media_mime, media_path, media_size';

interface ConvRow {
  id: string; lead_id: string | null; phone_e164: string;
  last_inbound_at: string | null; last_message_at: string | null; last_direction: string | null;
}

export interface EngineDeps {
  think: Thinker;
  freeSlots: (slug: string, phone: string, now: number, signal?: AbortSignal) => Promise<SlotList>;
  bookSlot: typeof bookSlot;
  rescheduleMeeting: typeof rescheduleMeeting;
  sendText: typeof sendText;
  sendMedia: typeof sendMedia;
  push: typeof pushToWorkspace;
}
export const realDeps: EngineDeps = { think: realThink, freeSlots, bookSlot, rescheduleMeeting, sendText, sendMedia, push: pushToWorkspace };

export interface RunReport {
  skipped?: string;
  answered: number; verdicts: number; booked: number; handedOver: number; waited: number; followUps: number;
  errors: string[];
}

interface Run {
  admin: Admin; durable: Admin; ctx: RunContext; deps: EngineDeps;
  ws: string; now: number; config: AiConfig; idx: AiIndex; aiUser: string | null; report: RunReport;
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);
const nameOf = (lead: LeadFacts | null, phone: string) => lead?.full_name?.trim() || phone;

// ---- the run ------------------------------------------------------------------

export async function runAssistant(opts: {
  admin: Admin; durable: Admin; ctx: RunContext; deps?: Partial<EngineDeps>; now?: number;
}): Promise<RunReport> {
  const { admin, durable, ctx } = opts;
  const now = opts.now ?? Date.now();
  const report: RunReport = { answered: 0, verdicts: 0, booked: 0, handedOver: 0, waited: 0, followUps: 0, errors: [] };

  const { data: wsRow } = await admin.from('workspaces').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!wsRow?.id) return { ...report, skipped: 'no workspace' };
  const ws = wsRow.id as string;

  const config = await loadConfig(admin, ws);
  if (!config.enabled) return { ...report, skipped: 'switched off' };
  const idx = await loadIndex(admin, ws);

  const { data: adminRow } = await admin.from('workspace_members').select('user_id')
    .eq('workspace_id', ws).eq('role', 'admin').eq('status', 'active').order('created_at', { ascending: true }).limit(1).maybeSingle();
  const run: Run = {
    admin, durable, ctx, ws, now, config, idx, report,
    deps: { ...realDeps, ...(opts.deps || {}) },
    aiUser: (adminRow?.user_id as string | undefined) ?? null,
  };
  if (!run.aiUser) return { ...report, skipped: 'no admin to send as' };

  try {
    const sinceMs = Math.max(ms(config.activatedAt), now - 24 * 3_600_000);
    const { data: convData, error: convErr } = await admin.from('relay_conversations')
      .select('id, lead_id, phone_e164, last_inbound_at, last_message_at, last_direction')
      .eq('workspace_id', ws).gte('last_inbound_at', new Date(sinceMs).toISOString())
      .order('last_inbound_at', { ascending: true }).limit(400);
    if (convErr) throw new Error(`conversations: ${convErr.message}`);
    const convs = (convData || []) as ConvRow[];
    const states = await loadStates(admin, ws, convs.map((c) => c.id));

    // 1. Finish anything decided on an earlier run but not fully sent.
    for (const c of convs) {
      const s = states.get(c.id);
      if (!s?.plan || !ctx.hasTime()) continue;
      await carryOut(run, c, s, null);
    }

    // 2. Decide the chats that are waiting, oldest first, a few at a time.
    const waiting = convs.filter((c) => {
      const s = states.get(c.id);
      if (c.last_direction !== 'in' || !c.last_inbound_at) return false;
      if (s && (s.status !== 'active' || s.plan || s.seenInboundAt === c.last_inbound_at)) return false;
      return now - ms(c.last_inbound_at) >= DEBOUNCE_MS && now - ms(c.last_inbound_at) <= WINDOW_SAFE_MS;
    });
    if (ctx.elapsedMs() < START_DECISIONS_BEFORE_MS) {
      await Promise.all(waiting.slice(0, MAX_DECISIONS_PER_RUN).map((c) =>
        handleChat(run, c).catch((e) => { report.errors.push(`${c.id.slice(0, 8)}: ${e instanceof Error ? e.message : 'failed'}`); })));
    }

    // 3. Housekeeping, when there is time left.
    if (ctx.hasTime()) await releaseHolds(run).catch((e) => { report.errors.push(`holds: ${e instanceof Error ? e.message : 'failed'}`); });
    if (ctx.hasTime() && config.followUps) await sendFollowUps(run).catch((e) => { report.errors.push(`follow-ups: ${e instanceof Error ? e.message : 'failed'}`); });
  } finally {
    await saveIndex(durable, ws, idx).catch((e) => { report.errors.push(`index: ${e instanceof Error ? e.message : 'failed'}`); });
  }
  return report;
}

// ---- one chat -----------------------------------------------------------------

async function handleChat(run: Run, conv: ConvRow): Promise<void> {
  const { admin, durable, ws, now, idx, deps, report } = run;
  const state = await loadState(admin, ws, conv.id);
  if (state.status !== 'active' || state.plan) return;

  const [msgRes, leadRes, suppRes] = await Promise.all([
    admin.from('relay_messages').select(MSG_COLS).eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(60),
    conv.lead_id
      ? admin.from('leads').select('id, full_name, stage, visa_type, eligibility, email, source').eq('id', conv.lead_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin.from('relay_suppressions').select('id').eq('workspace_id', ws).eq('phone_e164', conv.phone_e164).limit(1),
  ]);
  if (msgRes.error) throw new Error(`messages: ${msgRes.error.message}`);
  const messages = ((msgRes.data || []) as ChatMessage[]).filter((m) => !m.is_internal).reverse();
  const lead = (leadRes.data as LeadFacts | null) ?? null;
  const name = nameOf(lead, conv.phone_e164);

  const delivered = messages.filter((m) => !(m.direction === 'out' && m.status === 'failed'));
  const last = delivered[delivered.length - 1];
  const newest = [...messages].reverse().find((m) => m.direction === 'in');
  const settle = async (kind: string | null, note: string) => {
    if (newest) state.handledId = newest.id;
    state.seenInboundAt = conv.last_inbound_at ?? undefined;
    state.claim = undefined;
    if (kind) record(idx, state, { conversationId: conv.id, name, kind, note }, new Date(now).toISOString());
    await saveState(durable, ws, conv.id, state);
  };

  // Nothing of theirs waiting, or already dealt with.
  if (!newest || !last || last.direction !== 'in' || newest.id === state.handledId) return settle(null, '');
  // Only what arrived after the switch was turned on.
  if (ms(newest.created_at) <= ms(run.config.activatedAt)) return settle(null, '');
  if ((suppRes.data || []).length) return settle('left', 'They said STOP: no reply.');
  if (lead && CLIENT_STAGES.has((lead.stage || '').toLowerCase())) return settle('left', 'An existing client: left to the team.');

  // A teammate is in this chat right now: keep out, look again next minute.
  const humanAt = Math.max(0, ...messages.filter((m) => m.direction === 'out' && m.sent_by && !isAiMessage(m)).map((m) => ms(m.created_at)));
  if (now - humanAt < HUMAN_ACTIVE_MS) return;

  // A brand new lead's ad-form message belongs to the first-message automation.
  const outAfter = messages.some((m) => m.direction === 'out' && ms(m.created_at) >= ms(newest.created_at));
  if (/filled (in|out) your form/i.test(newest.body || '') && !outAfter && now - ms(newest.created_at) < NEW_LEAD_WAIT_MS) return;

  // Count the tries. Three failed attempts and a human gets it.
  const attempts = state.claim?.inboundId === newest.id ? state.claim.attempts + 1 : 1;
  if (attempts > MAX_ATTEMPTS) {
    await handOver(run, conv, state, name, `The assistant could not work out a reply after ${MAX_ATTEMPTS} tries (${state.claim?.error || 'no detail'}).`);
    return settle(null, '');
  }
  const [files, slots, meetings] = await Promise.all([
    readFiles(admin, messages),
    deps.freeSlots(run.config.bookingSlug, conv.phone_e164, now, run.ctx.signal),
    meetingsFor(admin, ws, { leadId: conv.lead_id, phoneE164: conv.phone_e164, email: lead?.email ?? null }),
  ]);
  const chat: ChatContext = { now, phoneE164: conv.phone_e164, lead, state, messages, files, slots, meetings };

  const timeoutMs = Math.min(THINK_TIMEOUT_MS, AI_BUDGET.hardStopMs - 4_000 - run.ctx.elapsedMs());
  if (timeoutMs < 6_000) return;                       // not enough of this run left; the next one takes it
  state.claim = { inboundId: newest.id, attempts };
  await saveState(durable, ws, conv.id, state);
  const thought = await deps.think(chat, { signal: run.ctx.signal, timeoutMs });

  if (!thought.ok) {
    report.errors.push(`${name}: ${thought.error}`);
    if (/ANTHROPIC_API_KEY|key was rejected|out of credit/i.test(thought.error)) {
      // The whole assistant is down, not this chat. Say so once on the page; do not burn the chat's tries.
      const fresh = !idx.problem || now - ms(idx.problem.at) > 3_600_000;
      idx.problem = { at: fresh ? new Date(now).toISOString() : idx.problem!.at, text: thought.error };
      if (fresh) await deps.push(admin, ws, { title: 'The assistant has stopped', body: thought.error, url: '/', tag: 'ai-problem' });
      state.claim = { inboundId: newest.id, attempts: attempts - 1 };
      await saveState(durable, ws, conv.id, state);
      return;
    }
    if (!thought.retryable) {
      await handOver(run, conv, state, name, `The assistant could not answer this chat (${thought.error}).`);
      return settle(null, '');
    }
    state.claim = { inboundId: newest.id, attempts, error: thought.error };
    await saveState(durable, ws, conv.id, state);
    return;
  }
  idx.problem = null;

  const checked = checkDecision(thought.decision, chat);
  if (checked.kind === 'handoff') {
    await handOver(run, conv, state, name, checked.reason);
    return settle(null, '');
  }
  if (checked.kind === 'wait') {
    report.waited++;
    return settle('waited', checked.note);
  }

  const plan = await makePlan(run, checked, lead);
  if ('error' in plan) {
    await handOver(run, conv, state, name, plan.error);
    return settle(null, '');
  }
  state.plan = { inboundId: newest.id, madeAt: new Date(now).toISOString(), kind: checked.kind, steps: plan.steps };
  state.slotTaken = undefined;
  await settle(null, '');
  await carryOut(run, conv, state, { lead, meetings, note: checked.note });
}

/** The customer's recent files, read so the brain can see them. */
export async function readFiles(admin: Admin, messages: ChatMessage[]): Promise<ChatFile[]> {
  const inbound = messages.filter((m) => m.direction === 'in' && m.media_path).slice(-15);
  const docs = inbound.filter((m) => m.media_type === 'document').slice(-2);
  const images = inbound.filter((m) => m.media_type === 'image').slice(-2);
  const load = async (m: ChatMessage): Promise<ChatFile> => {
    const name = m.media_name || 'file';
    try {
      const { data, error } = await admin.storage.from(RELAY_BUCKET).download(m.media_path as string);
      if (error || !data) return { name };
      const buf = Buffer.from(await data.arrayBuffer());
      if (m.media_type === 'image') {
        const mime = (m.media_mime || '').toLowerCase();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime) || buf.byteLength > 4_000_000) return { name };
        return { name, imageBase64: buf.toString('base64'), mime };
      }
      const cv = await extractCv(buf, name, m.media_mime).catch(() => null);
      if (cv && cv.text.length >= 400) return { name, text: cv.text };
      // A scanned or oddly encoded PDF: let the model read the pages themselves.
      const isPdf = (m.media_mime || '').includes('pdf') || /\.pdf$/i.test(name);
      if (isPdf && buf.byteLength <= 6_000_000) return { name, pdfBase64: buf.toString('base64') };
      return cv?.text ? { name, text: cv.text } : { name };
    } catch { return { name }; }
  };
  return Promise.all([...docs, ...images].map(load));
}

// ---- from a decision to the messages to send ------------------------------------

async function makePlan(run: Run, checked: Exclude<Checked, { kind: 'handoff' } | { kind: 'wait' }>, lead: LeadFacts | null):
Promise<{ steps: PlanStep[] } | { error: string }> {
  const text = (body: string): PlanStep => ({ kind: 'text', body, status: 'todo' });
  if (checked.kind === 'reply') return { steps: checked.messages.map(text) };
  if (checked.kind === 'book') {
    return { steps: [{ kind: 'book', slot: checked.slot, email: checked.email, reschedule: checked.reschedule, thenTexts: checked.messages, status: 'todo' }] };
  }

  const verdict: Verdict = checked.verdict === 'gtv_eligible' ? 'gtv' : checked.verdict === 'gtv_highly_eligible' ? 'gtv_high'
    : checked.verdict === 'ifv_eligible' ? 'ifv' : 'not';
  const shortcuts = VERDICT_REPLIES[verdict];
  const { data, error } = await run.admin.from('relay_quick_replies').select('shortcut, body, attachments')
    .eq('workspace_id', run.ws).in('shortcut', shortcuts);
  if (error) return { error: `Could not read the saved replies (${error.message}).` };
  type Qr = { shortcut: string; body: string | null; attachments: { path: string; name: string; mime: string; size: number }[] | null };
  const byShortcut = new Map(((data || []) as Qr[]).map((q) => [q.shortcut, q]));
  const steps: PlanStep[] = [];
  for (const sc of shortcuts) {
    const qr = byShortcut.get(sc);
    if (!qr || !(qr.body || '').trim()) return { error: `The saved reply "${sc}" is missing, so the verdict could not be sent.` };
    steps.push(text((qr.body as string).replace(/\{\{\s*name\s*\}\}/gi, firstNameOf(lead?.full_name)).trim()));
    for (const a of qr.attachments || []) steps.push({ kind: 'media', path: a.path, name: a.name, mime: a.mime, size: a.size, status: 'todo' });
  }
  for (const m of checked.messages) steps.push(text(m));
  steps.push({ kind: 'lead', verdict, reason: checked.note, status: 'todo' });
  return { steps };
}

// ---- sending ------------------------------------------------------------------

async function carryOut(
  run: Run, conv: ConvRow, state: AiState,
  known: { lead: LeadFacts | null; meetings: MeetingLite[]; note: string } | null,
): Promise<void> {
  const { admin, durable, ws, now, idx, deps, report, ctx } = run;
  const plan = state.plan;
  if (!plan) return;
  const save = () => saveState(durable, ws, conv.id, state);
  const at = new Date(now).toISOString();

  let lead = known?.lead ?? null;
  if (!known && conv.lead_id) {
    const { data } = await admin.from('leads').select('id, full_name, stage, visa_type, eligibility, email, source').eq('id', conv.lead_id).maybeSingle();
    lead = (data as LeadFacts | null) ?? null;
  }
  const name = nameOf(lead, conv.phone_e164);
  const untouched = plan.steps.every((s) => s.status === 'todo');

  // A step that was mid-flight when an earlier run ended: outcome unknown, never repeated.
  for (const s of plan.steps) if (s.status === 'doing') s.status = 'unknown';

  // Before the first message goes: has the chat moved on since this was decided?
  if (untouched) {
    const { data: since } = await admin.from('relay_messages').select('id, direction, sent_by, template_values, is_internal')
      .eq('conversation_id', conv.id).gt('created_at', plan.madeAt).limit(20);
    const rows = (since || []) as { id: string; direction: string; sent_by: string | null; template_values: { ai?: boolean } | null; is_internal: boolean | null }[];
    const humanSpoke = rows.some((m) => m.direction === 'out' && !m.is_internal && m.sent_by && m.template_values?.ai !== true);
    const customerSpoke = rows.some((m) => m.direction === 'in');
    if (humanSpoke || (customerSpoke && plan.kind === 'reply')) {
      state.plan = undefined;
      if (customerSpoke && !humanSpoke) { state.handledId = undefined; state.seenInboundAt = undefined; }
      record(idx, state, { conversationId: conv.id, name, kind: 'dropped', note: humanSpoke ? 'A teammate replied first; the draft was dropped.' : 'They wrote again before the reply went; deciding again.' }, at);
      return save();
    }
  }

  const fail = async (reason: string) => {
    state.plan = undefined;
    await handOver(run, conv, state, name, reason);
    await save();
  };
  const limits = { timeoutMs: CALL_TIMEOUT_MS, signal: ctx.signal };
  const insertOut = async (row: Record<string, unknown>) => {
    const { data } = await durable.from('relay_messages').insert({
      workspace_id: ws, conversation_id: conv.id, direction: 'out', status: 'queued',
      sent_by: run.aiUser, template_values: { ai: true }, ...row,
    }).select('id').single();
    return (data?.id as string | undefined) ?? null;
  };
  const stamp = async (id: string, r: { ok: boolean; code?: string; detail?: string; providerMsgId?: string }) => {
    const timedOut = !r.ok && r.code === 'timeout';
    await durable.from('relay_messages').update({
      status: r.ok ? 'sent' : timedOut ? 'queued' : 'failed',
      provider_msg_id: r.ok ? r.providerMsgId || null : null,
      error_code: r.ok ? null : r.code || 'unknown',
      error_detail: r.ok ? null : (r.detail || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', id);
    return timedOut;
  };

  let sentAny = false;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.status !== 'todo') continue;
    if (ctx.signal.aborted || ctx.elapsedMs() > AI_BUDGET.hardStopMs - 5_000) return save();   // the next run carries on

    if (step.kind === 'text' || step.kind === 'media') {
      const id = step.kind === 'text'
        ? await insertOut({ body: step.body })
        : await insertOut({ body: '', media_path: step.path, media_name: step.name, media_mime: step.mime, media_size: step.size, media_type: mediaTypeFrom(step.mime) || 'document' });
      if (!id) return fail('A reply could not be saved to the chat, so nothing more was sent.');
      step.status = 'doing'; step.messageId = id;
      await save();
      let r: { ok: boolean; code?: string; detail?: string; providerMsgId?: string };
      if (step.kind === 'text') {
        r = await deps.sendText({ phoneE164: conv.phone_e164, message: step.body, callbackData: id, limits });
      } else {
        const { data: signed } = await admin.storage.from(RELAY_BUCKET).createSignedUrl(step.path, 3600);
        const mt = mediaTypeFrom(step.mime) || 'document';
        r = signed?.signedUrl
          ? await deps.sendMedia({ phoneE164: conv.phone_e164, mediaUrl: signed.signedUrl, mediaType: mt === 'sticker' ? 'image' : mt, fileName: step.name, callbackData: id, limits })
          : { ok: false, code: 'no_file', detail: 'The brochure file could not be opened.' };
      }
      const timedOut = await stamp(id, r);
      step.status = r.ok ? 'done' : timedOut ? 'unknown' : 'failed';
      if (!r.ok && !timedOut) return fail(`A message could not be sent (${r.code || 'unknown'}${r.detail ? `: ${r.detail.slice(0, 120)}` : ''}).`);
      sentAny = true;
      await save();
      continue;
    }

    if (step.kind === 'book') {
      step.status = 'doing';
      await save();
      const meetings = known?.meetings ?? await meetingsFor(admin, ws, { leadId: conv.lead_id, phoneE164: conv.phone_e164, email: lead?.email ?? step.email });
      const current = meetings.find((m) => m.status === 'upcoming' && ms(m.starts_at) > now);
      let r: BookResult;
      if (step.reschedule && current?.manage_token) r = await deps.rescheduleMeeting({ token: current.manage_token, slot: step.slot });
      else r = await deps.bookSlot({ slug: run.config.bookingSlug, slot: step.slot, name: lead?.full_name?.trim() || 'WhatsApp lead', email: step.email, phoneE164: conv.phone_e164 });

      if (!r.ok && (r.reason === 'timeout' || r.reason === 'network')) {
        // It may have landed. The calendar is the truth.
        const after = await meetingsFor(admin, ws, { leadId: conv.lead_id, phoneE164: conv.phone_e164, email: step.email }).catch(() => []);
        const landed = after.find((m) => m.status === 'upcoming' && ms(m.starts_at) === ms(step.slot));
        if (landed) r = { ok: true, reason: null, meetLink: landed.meet_link };
      }
      if (!r.ok) {
        step.status = 'failed';
        if (r.reason === 'slot_taken') {
          // Somebody took it a moment ago: decide again, offering other times.
          state.plan = undefined; state.slotTaken = step.slot; state.handledId = undefined; state.seenInboundAt = undefined;
          record(idx, state, { conversationId: conv.id, name, kind: 'slot taken', note: `${describeSlot(step.slot, conv.phone_e164)} was just taken; offering other times.` }, at);
          return save();
        }
        return fail(`The call could not be booked (${r.reason || 'unknown'}). They asked for ${describeSlot(step.slot, conv.phone_e164)}.`);
      }
      step.status = 'done';
      const link = r.meetLink || current?.meet_link || '';
      const texts = step.thenTexts.map((t) => link
        ? t.replace(/\{\{MEET_LINK\}\}/g, link)
        : t.split('\n').filter((line) => !line.includes('{{MEET_LINK}}')).join('\n').replace(/\s*Meeting link:\s*\{\{MEET_LINK\}\}\.?/g, '').trim()).filter(Boolean);
      plan.steps.push(...texts.map((body): PlanStep => ({ kind: 'text', body, status: 'todo' })));
      state.meetingStart = step.slot; state.meetingSeenAt = at;
      delete idx.followUps[conv.id];
      report.booked++;
      record(idx, state, { conversationId: conv.id, name, kind: step.reschedule && current ? 'rescheduled' : 'booked', note: `Call ${step.reschedule && current ? 'moved to' : 'booked for'} ${describeSlot(step.slot, conv.phone_e164)}.` }, at);
      await save();
      continue;
    }

    if (step.kind === 'lead') {
      step.status = 'doing';
      const v = step.verdict;
      state.verdict = v; state.verdictAt = at;
      if (lead) {
        const isIfvLead = /ifv|innovator/i.test(lead.visa_type || '');
        const eligibility = v === 'gtv_high' ? 'highly_eligible' : v === 'gtv' || (v === 'ifv' && isIfvLead) ? 'eligible' : 'not_eligible';
        await durable.from('leads').update({ eligibility, eligibility_at: at, eligibility_source: 'ai' }).eq('id', lead.id);
      }
      // The strongest profiles are starred, so the Hot & Spotlight series keeps educating them.
      if (v === 'gtv_high') await durable.from('relay_conversations').update({ spotlight: true }).eq('id', conv.id);
      if (v === 'gtv' || v === 'gtv_high') {
        state.linkAt = at;
        idx.followUps[conv.id] = { since: at, step: 0, name, phone: conv.phone_e164, leadId: conv.lead_id };
      }
      await durable.from('relay_messages').insert({
        workspace_id: ws, conversation_id: conv.id, direction: 'out', is_internal: true, status: 'sent',
        sent_by: run.aiUser, template_values: { ai: true },
        body: `Assistant's verdict: ${VERDICT_LABEL[v]}.${step.reason ? ` ${step.reason}` : ''}`,
      });
      step.status = 'done';
      report.verdicts++;
      record(idx, state, { conversationId: conv.id, name, kind: 'verdict', note: `${VERDICT_LABEL[v]}.${step.reason ? ` ${step.reason}` : ''}` }, at);
      await save();
      continue;
    }
  }

  // Everything went.
  if (plan.kind === 'reply' && sentAny) {
    report.answered++;
    record(idx, state, { conversationId: conv.id, name, kind: 'replied', note: known?.note || 'Replied.' }, at);
  }
  state.plan = undefined;
  await save();
}

// ---- handing a chat to a human --------------------------------------------------

async function handOver(run: Run, conv: ConvRow, state: AiState, name: string, reason: string): Promise<void> {
  const { durable, ws, now, idx, report } = run;
  const at = new Date(now).toISOString();
  state.status = 'hold'; state.holdReason = reason; state.holdAt = at; state.claim = undefined; state.plan = undefined;
  idx.holds[conv.id] = { at, reason, name, phone: conv.phone_e164 };
  record(idx, state, { conversationId: conv.id, name, kind: 'handed over', note: reason }, at);
  report.handedOver++;
  // Saving any message marks the chat as read and answered (a database rule). This chat is neither:
  // put the unread badge and "waiting for us" back, so it still stands out in the list.
  const { data: before } = await durable.from('relay_conversations').select('unread_count').eq('id', conv.id).maybeSingle();
  await durable.from('relay_messages').insert({
    workspace_id: ws, conversation_id: conv.id, direction: 'out', is_internal: true, status: 'sent',
    sent_by: run.aiUser, template_values: { ai: true },
    body: `The assistant has stopped replying here and needs you. ${reason}`,
  });
  await durable.from('relay_conversations')
    .update({ unread_count: Math.max(1, Number(before?.unread_count) || 0), last_direction: 'in' }).eq('id', conv.id);
  await run.deps.push(run.admin, ws, { title: `Needs you · ${name}`, body: reason.slice(0, 160), url: '/', tag: `ai-${conv.id}` });
}

/** Gives a chat back to the assistant once a human has dealt with it and gone quiet. */
async function releaseHolds(run: Run): Promise<void> {
  const { admin, durable, ws, now, idx } = run;
  const ids = Object.keys(idx.holds).slice(0, 100);
  if (!ids.length) return;
  const oldest = Math.min(...ids.map((id) => ms(idx.holds[id].at)));
  const { data } = await admin.from('relay_messages').select('conversation_id, created_at, template_values')
    .in('conversation_id', ids).eq('direction', 'out').eq('is_internal', false).not('sent_by', 'is', null)
    .gte('created_at', new Date(oldest).toISOString()).order('created_at', { ascending: false }).limit(1000);
  const lastHuman = new Map<string, number>();
  for (const m of (data || []) as { conversation_id: string; created_at: string; template_values: { ai?: boolean } | null }[]) {
    if (m.template_values?.ai === true) continue;
    lastHuman.set(m.conversation_id, Math.max(lastHuman.get(m.conversation_id) ?? 0, ms(m.created_at)));
  }
  for (const id of ids) {
    const h = idx.holds[id];
    const human = lastHuman.get(id) ?? 0;
    const answered = human > ms(h.at) && now - human >= HOLD_RELEASE_MS;
    const stale = now - ms(h.at) >= HOLD_EXPIRE_MS;
    if (!answered && !stale) continue;
    const state = await loadState(admin, ws, id);
    if (state.status === 'hold') {
      await resumeChat(admin, id, state);
      record(idx, state, { conversationId: id, name: h.name, kind: 'resumed', note: answered ? 'A teammate replied and 12 hours passed: the assistant is back on this chat.' : 'Two weeks passed: the assistant is back on this chat.' }, new Date(now).toISOString());
      await saveState(durable, ws, id, state);
    }
    delete idx.holds[id];
  }
}

/** Back to active, without answering anything that came in while a human had the chat. */
export async function resumeChat(admin: Admin, conversationId: string, state: AiState): Promise<void> {
  const [{ data: conv }, { data: newest }] = await Promise.all([
    admin.from('relay_conversations').select('last_inbound_at').eq('id', conversationId).maybeSingle(),
    admin.from('relay_messages').select('id').eq('conversation_id', conversationId).eq('direction', 'in').order('created_at', { ascending: false }).limit(1),
  ]);
  state.status = 'active'; state.holdReason = undefined; state.holdAt = undefined; state.claim = undefined; state.plan = undefined;
  state.seenInboundAt = (conv?.last_inbound_at as string | undefined) ?? undefined;
  state.handledId = (newest?.[0]?.id as string | undefined) ?? state.handledId;
}

// ---- making sure eligible people book -------------------------------------------

async function sendFollowUps(run: Run): Promise<void> {
  const { admin, durable, ws, now, idx, ctx, report } = run;
  const hourIst = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date(now)));
  if (hourIst < 10 || hourIst >= 19) return;
  const due = Object.entries(idx.followUps).filter(([, f]) => now - Math.max(ms(f.since), ms(f.lastAt)) >= FOLLOW_UP_GAPS_MS[Math.min(f.step, 2)]).slice(0, 5);
  if (!due.length) return;
  const ids = due.map(([id]) => id);
  const [convRes, eco, autoRes] = await Promise.all([
    admin.from('relay_conversations').select('id, lead_id, phone_e164, last_inbound_at, last_message_at, last_direction').in('id', ids),
    ecosystemStatesByConv(admin, ids, now),
    admin.from('relay_messages').select('conversation_id').in('conversation_id', ids).eq('direction', 'out').is('sent_by', null)
      .neq('status', 'failed').gte('created_at', new Date(now - CROSS_ENGINE_GAP_MS).toISOString()).limit(200),
  ]);
  const convById = new Map(((convRes.data || []) as ConvRow[]).map((c) => [c.id, c]));
  const recentlyAutomated = new Set(((autoRes.data || []) as { conversation_id: string }[]).map((m) => m.conversation_id));

  for (const [id, f] of due) {
    if (!ctx.hasTime()) return;
    const at = new Date(now).toISOString();
    const conv = convById.get(id);
    const drop = async (why: string) => {
      delete idx.followUps[id];
      const s = await loadState(admin, ws, id);
      record(idx, s, { conversationId: id, name: f.name, kind: 'follow-ups ended', note: why }, at);
      await saveState(durable, ws, id, s);
    };
    if (!conv || f.step >= FOLLOW_UP_TEMPLATES.length) { delete idx.followUps[id]; continue; }

    const [state, leadRes, suppRes, meetings] = await Promise.all([
      loadState(admin, ws, id),
      conv.lead_id ? admin.from('leads').select('id, full_name, stage, visa_type, eligibility, email, source, retired_at').eq('id', conv.lead_id).maybeSingle() : Promise.resolve({ data: null }),
      admin.from('relay_suppressions').select('id').eq('workspace_id', ws).eq('phone_e164', conv.phone_e164).limit(1),
      meetingsFor(admin, ws, { leadId: conv.lead_id, phoneE164: conv.phone_e164, email: null }),
    ]);
    const lead = leadRes.data as (LeadFacts & { retired_at?: string | null }) | null;
    if (state.status !== 'active' || state.plan) continue;                         // a human has it, or a reply is mid-flight
    if ((suppRes.data || []).length) { await drop('They said STOP.'); continue; }
    if (lead && (CLOSED_STAGES.has((lead.stage || '').toLowerCase()) || lead.retired_at)) { await drop(`Their stage is now ${lead.stage || 'closed'}.`); continue; }
    const booked = meetings.find((m) => ['upcoming', 'completed'].includes(m.status) && ms(m.created_at) >= ms(f.since) - 3_600_000);
    if (booked) {
      delete idx.followUps[id];
      state.meetingStart = booked.starts_at; state.meetingSeenAt = at;
      record(idx, state, { conversationId: id, name: f.name, kind: 'booked', note: `They booked a call for ${describeSlot(booked.starts_at, conv.phone_e164)}.` }, at);
      await saveState(durable, ws, id, state);
      continue;
    }
    // The clock runs from the last message either way: a live conversation is never interrupted.
    const quietSince = Math.max(ms(f.since), ms(f.lastAt), ms(conv.last_message_at));
    if (now - quietSince < FOLLOW_UP_GAPS_MS[Math.min(f.step, 2)]) continue;
    if (heldByEcosystem(eco.get(id), now) || recentlyAutomated.has(id)) continue;

    const r = await sendTemplateToLead(admin, {
      workspaceId: ws, conversationId: id, phoneE164: conv.phone_e164,
      templateName: FOLLOW_UP_TEMPLATES[f.step], language: 'en',
      lead: { full_name: lead?.full_name ?? null, visa_type: lead?.visa_type ?? null },
    }, ctx);
    if (r.timedOut) continue;
    if (r.ok) {
      f.step += 1; f.lastAt = at; f.fails = 0;
      report.followUps++;
      record(idx, state, { conversationId: id, name: f.name, kind: 'follow-up', note: `Call-booking follow-up ${f.step} of 3 sent.` }, at);
      await saveState(durable, ws, id, state);
      if (f.step >= FOLLOW_UP_TEMPLATES.length) delete idx.followUps[id];
    } else {
      f.fails = (f.fails || 0) + 1; f.lastAt = at;
      if (f.fails >= 2) await drop(`The follow-up could not be sent (${r.error || 'unknown'}).`);
    }
  }
}

