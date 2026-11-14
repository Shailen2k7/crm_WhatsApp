// =============================================================================
// BROADCAST ENGINE — sends a launched broadcast, a few people at a time.
// -----------------------------------------------------------------------------
// Called every 2 minutes by the Netlify function `broadcast-run`, and by the
// Broadcast page itself while someone is watching (so a small send finishes in
// seconds). Both go through one lock, so two runs never overlap.
//
// Each run, for every broadcast that is 'sending':
//
//   1. QUIET HOURS   9 pm – 9 am IST nothing goes (unless switched off for it).
//   2. PACE          no more than the chosen speed allows since it (re)started.
//   3. SAFETY        if WhatsApp is refusing most of the recent messages, or
//                    Interakt's balance runs out, or five sends in a row fail,
//                    it PAUSES ITSELF and says why. Nothing is lost: the people
//                    still waiting stay waiting, and Resume carries on.
//   4. PER PERSON, read fresh at the moment of sending:
//        STOP since launch                → skipped
//        Meta's per-person marketing cap  → skipped (it would be refused)
//        an automated message < 35 min ago, or a lead < 30 min old
//                                         → held to a later run (see below)
//        otherwise                        → CLAIMED, then sent
//
// THE CLAIM. The person's row is moved queued → sent ('in flight') BEFORE
// Interakt is called. If the run dies mid-send the row stays 'sent' and is
// never picked up again: a rare unconfirmed line in the results, never a
// second copy of an offer on someone's phone.
//
// THE 35 MINUTES. The automations read "an automated message failed within
// 30 minutes of my step" as "my step was refused" and re-send that step. A
// broadcast landing right after a T2 or a CC3, then being refused by Meta,
// would look exactly like that. Waiting out the half hour keeps a broadcast
// from ever being mistaken for somebody's step. The lead-age wait is the same
// idea for T1: a new lead must get the first message before anything else.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { CALL_TIMEOUT_MS, forEachLimited, type RunContext } from '@/lib/automation/run-context';
import { ecosystemStatesByConv, heldByEcosystem } from '@/lib/automation/ecosystem';
import { matchKey } from '@/lib/phone';
import {
  RATE_PER_MIN, countVars, inQuietHours, metaKey, quietHoursEnd, resolveValues,
  type BroadcastMeta, type BroadcastStatus,
} from './model';
import { normaliseSpec } from './audience';
import { friendlyFailure, isWalletError, resolveHeader, sendBroadcastMessage, type ResolvedHeader } from './send';

export const BROADCAST_LOCK_KEY = 'broadcast_run_lock';
/** One run never sends more than this, whatever the speed. */
export const MAX_PER_RUN = 40;
const CONCURRENCY = 4;
const AUTOMATION_GAP_MS = 35 * 60_000;
const NEW_LEAD_WAIT_MS = 30 * 60_000;
const FAIL_STREAK_PAUSE = 5;
const IN_FLIGHT = 'in flight';
export const UNCONFIRMED = 'Interakt did not answer in time — delivery unknown.';

export interface CampaignRow {
  id: string; workspace_id: string; name: string; template_name: string; template_language: string;
  status: BroadcastStatus; scheduled_at: string | null; total: number; sent: number; failed: number; skipped: number;
  created_by: string | null; created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
}
export const CAMPAIGN_COLS =
  'id, workspace_id, name, template_name, template_language, status, scheduled_at, total, sent, failed, skipped, created_by, created_at, updated_at, started_at, finished_at';

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---- the JSON that rides beside a campaign row ---------------------------------

export function normaliseMeta(raw: Partial<BroadcastMeta> | null | undefined): BroadcastMeta {
  const m = raw || {};
  return {
    spec: normaliseSpec(m.spec),
    variables: Array.isArray(m.variables) ? m.variables : [],
    rate: m.rate === 'fast' || m.rate === 'gentle' ? m.rate : 'normal',
    quietHours: m.quietHours !== false,
    header: m.header && typeof m.header === 'object' && m.header.format ? m.header : null,
    body: typeof m.body === 'string' ? m.body : '',
    paceAnchorAt: m.paceAnchorAt || null,
    pausedReason: m.pausedReason || null,
    healthFrom: m.healthFrom || null,
    createdByName: m.createdByName || null,
    audienceLabel: m.audienceLabel || null,
  };
}

export async function loadMeta(admin: SupabaseClient, ws: string, campaignId: string): Promise<BroadcastMeta | null> {
  const { data } = await admin.from('relay_settings').select('value')
    .eq('workspace_id', ws).eq('key', metaKey(campaignId)).maybeSingle();
  if (!data?.value) return null;
  try { return normaliseMeta(JSON.parse(data.value as string)); } catch { return null; }
}

export async function loadMetas(admin: SupabaseClient, ws: string, ids: string[]): Promise<Map<string, BroadcastMeta>> {
  const out = new Map<string, BroadcastMeta>();
  for (const part of chunk(ids, 100)) {
    const { data } = await admin.from('relay_settings').select('key, value')
      .eq('workspace_id', ws).in('key', part.map(metaKey));
    for (const r of (data || []) as { key: string; value: string | null }[]) {
      try { if (r.value) out.set(r.key.slice('broadcast:'.length), normaliseMeta(JSON.parse(r.value))); } catch { /* unreadable: treated as missing */ }
    }
  }
  return out;
}

export async function saveMeta(admin: SupabaseClient, ws: string, campaignId: string, meta: BroadcastMeta): Promise<string | null> {
  const { error } = await admin.from('relay_settings').upsert(
    { workspace_id: ws, key: metaKey(campaignId), value: JSON.stringify(meta), updated_at: new Date().toISOString() },
    { onConflict: 'workspace_id,key' },
  );
  return error ? error.message : null;
}

// ---- counters ---------------------------------------------------------------

/**
 * A message Interakt accepted can still be refused by WhatsApp a few seconds
 * later (the webhook marks the chat message failed). This carries that verdict
 * onto the person's line, so "failed" always means "did not arrive" and Retry
 * failed can pick them up.
 */
export async function reconcileRefusals(admin: SupabaseClient, c: CampaignRow): Promise<number> {
  if (!c.started_at) return 0;
  const { data, error } = await admin.from('relay_messages')
    .select('id, error_code, error_detail')
    .eq('workspace_id', c.workspace_id).eq('direction', 'out').eq('status', 'failed')
    .eq('template_name', c.template_name).is('sent_by', null)
    .gte('created_at', c.started_at).limit(5000);
  if (error || !data?.length) return 0;
  const fails = data as { id: string; error_code: string | null; error_detail: string | null }[];
  let moved = 0;
  // Group by reason so each reason is one UPDATE, not one per person.
  const byReason = new Map<string, string[]>();
  for (const f of fails) {
    const reason = friendlyFailure(f.error_code, f.error_detail);
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)!.push(f.id);
  }
  for (const [reason, ids] of byReason) {
    for (const part of chunk(ids, 100)) {
      const { data: upd } = await admin.from('relay_campaign_recipients')
        .update({ status: 'failed', error: reason })
        .eq('campaign_id', c.id).eq('status', 'sent').in('message_id', part).select('id');
      moved += upd?.length || 0;
    }
  }
  return moved;
}

async function countStatus(admin: SupabaseClient, campaignId: string, status: string): Promise<number> {
  const { count } = await admin.from('relay_campaign_recipients')
    .select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', status);
  return count || 0;
}

/** Recounts a broadcast from its people and writes the totals on its row. */
export async function refreshCounters(
  admin: SupabaseClient, c: CampaignRow,
): Promise<{ queued: number; sent: number; failed: number; skipped: number }> {
  await reconcileRefusals(admin, c);
  const [queued, sent, failed, skipped] = await Promise.all([
    countStatus(admin, c.id, 'queued'), countStatus(admin, c.id, 'sent'),
    countStatus(admin, c.id, 'failed'), countStatus(admin, c.id, 'skipped'),
  ]);
  const total = queued + sent + failed + skipped;
  if (total !== c.total || sent !== c.sent || failed !== c.failed || skipped !== c.skipped) {
    await admin.from('relay_campaigns')
      .update({ total, sent, failed, skipped, updated_at: new Date().toISOString() }).eq('id', c.id);
  }
  return { queued, sent, failed, skipped };
}

async function pauseItself(admin: SupabaseClient, c: CampaignRow, meta: BroadcastMeta, reason: string): Promise<void> {
  await saveMeta(admin, c.workspace_id, c.id, { ...meta, pausedReason: reason });
  await admin.from('relay_campaigns')
    .update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', c.id).eq('status', 'sending');
}

// ---- the safety check ---------------------------------------------------------

/** Most of the last 20 accepted messages refused by WhatsApp → the reason, else null. */
async function refusalAlarm(admin: SupabaseClient, c: CampaignRow, meta: BroadcastMeta, now: number): Promise<string | null> {
  const from = meta.healthFrom || c.started_at;
  if (!from) return null;
  // Lines already carried over to 'failed' by the reconcile are part of the picture.
  const { data } = await admin.from('relay_campaign_recipients')
    .select('status, error, sent_at')
    .eq('campaign_id', c.id).in('status', ['sent', 'failed']).not('message_id', 'is', null)
    .gte('sent_at', from).lte('sent_at', new Date(now - 90_000).toISOString())
    .order('sent_at', { ascending: false }).limit(20);
  const rows = (data || []) as { status: string; error: string | null }[];
  if (rows.length < 12) return null;
  const bad = rows.filter((r) => r.status === 'failed');
  if (bad.length < rows.length * 0.75) return null;
  const tally = new Map<string, number>();
  for (const r of bad) tally.set(r.error || 'unknown reason', (tally.get(r.error || 'unknown reason') || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown reason';
  return `WhatsApp refused ${bad.length} of the last ${rows.length} messages (“${top}”). Paused so no more are wasted — check the template and your Interakt account, then press Resume.`;
}

// ---- one run -------------------------------------------------------------------

export interface RunReport {
  campaigns: { id: string; name: string; sent: number; failed: number; skipped: number; held: number; waiting: number; note?: string }[];
  started: string[];
  sentTotal: number;
  /** True when there is more to send right now (the page calls again sooner). */
  more: boolean;
}

interface RecipientRow { id: string; lead_id: string | null; phone_e164: string; full_name: string | null }

export async function runBroadcasts(opts: {
  /** Reads: bounded by the run's time limits. */
  admin: SupabaseClient;
  /** Writes that must land even if the run is out of time. */
  durable: SupabaseClient;
  ctx: RunContext;
  workspaceId: string | null;
  now?: number;
}): Promise<RunReport> {
  const { admin, durable, ctx } = opts;
  const now = opts.now ?? Date.now();
  const report: RunReport = { campaigns: [], started: [], sentTotal: 0, more: false };

  // ---- scheduled broadcasts whose time has come ------------------------------
  {
    let q = admin.from('relay_campaigns').select(CAMPAIGN_COLS)
      .eq('status', 'scheduled').lte('scheduled_at', new Date(now).toISOString()).limit(20);
    if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId);
    const { data } = await q;
    for (const c of (data || []) as CampaignRow[]) {
      const startedAt = new Date(now).toISOString();
      const { data: upd } = await durable.from('relay_campaigns')
        .update({ status: 'sending', started_at: startedAt, updated_at: startedAt })
        .eq('id', c.id).eq('status', 'scheduled').select('id');
      if (!upd?.length) continue;
      const meta = await loadMeta(durable, c.workspace_id, c.id);
      if (meta) await saveMeta(durable, c.workspace_id, c.id, { ...meta, paceAnchorAt: startedAt, healthFrom: startedAt, pausedReason: null });
      report.started.push(c.name);
    }
  }

  // ---- everything that is sending ------------------------------------------------
  let q = admin.from('relay_campaigns').select(CAMPAIGN_COLS)
    .eq('status', 'sending').order('started_at', { ascending: true }).limit(20);
  if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId);
  const { data: active, error: activeErr } = await q;
  if (activeErr) throw new Error(`broadcasts: ${activeErr.message}`);

  let runBudget = MAX_PER_RUN;
  for (const c of (active || []) as CampaignRow[]) {
    if (!ctx.hasTime()) { report.more = true; break; }
    const line = { id: c.id, name: c.name, sent: 0, failed: 0, skipped: 0, held: 0, waiting: 0 } as RunReport['campaigns'][number];
    report.campaigns.push(line);

    const meta = await loadMeta(admin, c.workspace_id, c.id);
    if (!meta || !meta.body) {
      await pauseItself(durable, c, normaliseMeta(meta), 'This broadcast lost its saved settings, so it was paused. Cancel it and make a new one.');
      line.note = 'paused — settings missing';
      continue;
    }

    // Verdicts that arrived since the last run, then: is WhatsApp refusing most of it?
    await reconcileRefusals(durable, c);
    const alarm = await refusalAlarm(admin, c, meta, now);
    if (alarm) {
      await pauseItself(durable, c, meta, alarm);
      await refreshCounters(durable, c);
      line.note = 'paused — most recent messages refused';
      continue;
    }

    if (meta.quietHours && inQuietHours(now)) {
      line.note = `quiet hours — carries on at ${quietHoursEnd(now)}`;
      line.waiting = await countStatus(admin, c.id, 'queued');
      continue;
    }

    // ---- pace: what the chosen speed allows since it (re)started ---------------
    const anchor = meta.paceAnchorAt || c.started_at || new Date(now).toISOString();
    const { count: attempted } = await admin.from('relay_campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id).in('status', ['sent', 'failed']).gte('sent_at', anchor);
    const minutes = Math.max(0, (now - new Date(anchor).getTime()) / 60_000);
    const allowed = Math.floor((minutes + 1) * RATE_PER_MIN[meta.rate]) - (attempted || 0);
    const want = Math.min(allowed, runBudget);
    if (want <= 0) {
      line.waiting = await countStatus(admin, c.id, 'queued');
      line.note = runBudget <= 0 ? 'this run is full' : 'pacing';
      if (line.waiting > 0 && runBudget <= 0) report.more = true;
      if (line.waiting === 0) await finishIfDone(durable, c);
      continue;
    }

    // A few spare, because some of them will be skipped or held, not sent.
    const { data: picked, error: pickErr } = await admin.from('relay_campaign_recipients')
      .select('id, lead_id, phone_e164, full_name')
      .eq('campaign_id', c.id).eq('status', 'queued').order('id').limit(want + 30);
    if (pickErr) { line.note = `could not read the list: ${pickErr.message}`; continue; }
    const people = (picked || []) as RecipientRow[];
    if (!people.length) { await finishIfDone(durable, c); continue; }

    // ---- everything about these people, in a few batched reads ------------------
    const phones = [...new Set(people.map((p) => p.phone_e164))];
    const leadIds = [...new Set(people.map((p) => p.lead_id).filter(Boolean) as string[])];
    const [stopRes, convRes, leadRes, headerRes] = await Promise.all([
      admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', c.workspace_id).limit(10000),
      admin.from('relay_conversations').select('id, phone_e164').eq('workspace_id', c.workspace_id).in('phone_e164', phones),
      leadIds.length
        ? admin.from('leads').select('id, full_name, visa_type, created_at').in('id', leadIds)
        : Promise.resolve({ data: [], error: null }),
      resolveHeader(admin, c.template_name, meta.header),
    ]);
    if (stopRes.error || convRes.error || leadRes.error) {
      line.note = `could not read the people: ${(stopRes.error || convRes.error || leadRes.error)!.message}`;
      continue;
    }
    if (headerRes.missing) {
      await pauseItself(durable, c, meta, `“${c.template_name}” needs its file (PDF or image) and none is set up. Add it in Files → template headers, then press Resume.`);
      line.note = 'paused — header file missing';
      continue;
    }
    const header: ResolvedHeader | null = headerRes.header;
    const stopSet = new Set(((stopRes.data || []) as { phone_e164: string }[]).map((s) => s.phone_e164));
    const stop10 = new Set([...stopSet].map((p) => matchKey(p)).filter(Boolean) as string[]);
    const convByPhone = new Map(((convRes.data || []) as { id: string; phone_e164: string }[]).map((x) => [x.phone_e164, x.id]));
    const leadById = new Map(((leadRes.data || []) as { id: string; full_name: string | null; visa_type: string | null; created_at: string }[]).map((l) => [l.id, l]));

    const convIds = [...new Set([...convByPhone.values()])];
    const sinceIso = new Date(now - AUTOMATION_GAP_MS).toISOString();
    const [eco, recentParts] = await Promise.all([
      ecosystemStatesByConv(admin, convIds, now),
      Promise.all(chunk(convIds, 100).map((ids) => admin.from('relay_messages').select('conversation_id')
        .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null).gte('created_at', sinceIso).limit(2000))),
    ]);
    const justAutomated = new Set<string>();
    for (const part of recentParts) {
      for (const m of (part.data || []) as { conversation_id: string }[]) justAutomated.add(m.conversation_id);
    }

    const varCount = countVars(meta.body);
    let done = 0;
    let streak = 0;
    let stopReason: string | null = null;
    let halted = false;
    let checkedAt = -1;

    const settle = (id: string, status: 'skipped' | 'failed', error: string) =>
      durable.from('relay_campaign_recipients').update({ status, error }).eq('id', id).eq('status', 'queued');

    await forEachLimited(people, CONCURRENCY, () => ctx.hasTime() && done < want && !stopReason && !halted, async (p) => {
      if (stopSet.has(p.phone_e164) || stop10.has(matchKey(p.phone_e164) || '-')) {
        await settle(p.id, 'skipped', 'They asked us to stop messaging them (STOP).');
        line.skipped++; return;
      }
      const lead = p.lead_id ? leadById.get(p.lead_id) : undefined;
      if (lead && now - new Date(lead.created_at).getTime() < NEW_LEAD_WAIT_MS) { line.held++; return; }

      let conversationId = convByPhone.get(p.phone_e164) || null;
      if (conversationId) {
        const state = eco.get(conversationId);
        if (heldByEcosystem(state, now)) {
          await settle(p.id, 'skipped', state?.stopped
            ? 'WhatsApp has refused marketing messages to this person three times — not sent.'
            : 'WhatsApp is limiting marketing messages to this person right now — not sent.');
          line.skipped++; return;
        }
        if (justAutomated.has(conversationId)) { line.held++; return; }
      } else {
        const { data, error } = await admin.rpc('relay_get_or_create_conversation', {
          p_workspace_id: c.workspace_id, p_phone_e164: p.phone_e164,
        });
        conversationId = !error && data ? (data as string) : null;
        if (!conversationId) { line.held++; return; }      // a database hiccup: try again next run
      }

      // The run may have filled up while this person waited their turn.
      if (done >= want || stopReason || halted || !ctx.hasTime()) return;
      // Pause and Cancel must bite within seconds, not at the end of the batch:
      // every few sends, look at the broadcast's own row again.
      if (done > 0 && done % 6 === 0 && checkedAt !== done) {
        checkedAt = done;
        const { data: row } = await admin.from('relay_campaigns').select('status').eq('id', c.id).maybeSingle();
        if (row && row.status !== 'sending') { halted = true; return; }
      }
      done++;

      // THE CLAIM — after this line the person can never be picked again.
      const { data: claimed } = await durable.from('relay_campaign_recipients')
        .update({ status: 'sent', error: IN_FLIGHT, sent_at: new Date().toISOString() })
        .eq('id', p.id).eq('status', 'queued').select('id');
      if (!claimed?.length) { done--; return; }

      const result = await sendBroadcastMessage(durable, {
        workspaceId: c.workspace_id, conversationId, phoneE164: p.phone_e164,
        templateName: c.template_name, language: c.template_language, body: meta.body,
        values: resolveValues(meta.variables, varCount, { full_name: (lead?.full_name || '').trim() || p.full_name, visa_type: lead?.visa_type }),
        header, sentBy: null, failOwner: c.created_by,
        limits: { timeoutMs: CALL_TIMEOUT_MS * 2, signal: ctx.signal },
      });

      if (result.ok || result.timedOut) {
        await durable.from('relay_campaign_recipients')
          .update({ message_id: result.messageId, error: result.ok ? null : UNCONFIRMED }).eq('id', p.id);
        line.sent++; streak = 0;
        return;
      }
      await durable.from('relay_campaign_recipients')
        .update({ status: 'failed', message_id: result.messageId, error: friendlyFailure(result.code, result.detail) }).eq('id', p.id);
      line.failed++; streak++;
      if (isWalletError(result.detail)) {
        stopReason = 'Interakt balance ran out, so the broadcast paused itself. Recharge the Interakt wallet, then press Resume — the people still waiting are untouched, and “Retry failed” picks up the few that failed.';
      } else if (streak >= FAIL_STREAK_PAUSE) {
        stopReason = `${FAIL_STREAK_PAUSE} sends in a row failed (“${friendlyFailure(result.code, result.detail)}”), so the broadcast paused itself. Fix the cause, then press Resume.`;
      }
    });

    runBudget -= line.sent + line.failed;
    report.sentTotal += line.sent;

    if (stopReason) {
      await pauseItself(durable, c, meta, stopReason);
      line.note = 'paused — sends failing';
    }
    const counts = await refreshCounters(durable, c);
    line.waiting = counts.queued;
    if (halted) line.note = 'paused or cancelled mid-run';
    if (!stopReason && !halted) {
      if (counts.queued === 0) await finishIfDone(durable, c);
      else if (line.held < counts.queued) report.more = true;
    }
  }

  // ---- late verdicts on broadcasts that finished in the last two days -----------
  if (ctx.hasTime()) {
    let rq = admin.from('relay_campaigns').select(CAMPAIGN_COLS)
      .in('status', ['done', 'paused', 'cancelled'])
      .gte('finished_at', new Date(now - 48 * 3_600_000).toISOString())
      .lt('updated_at', new Date(now - 10 * 60_000).toISOString())
      .order('updated_at', { ascending: true }).limit(3);
    if (opts.workspaceId) rq = rq.eq('workspace_id', opts.workspaceId);
    const { data: recent } = await rq;
    for (const c of (recent || []) as CampaignRow[]) {
      if (!ctx.hasTime()) break;
      await refreshCounters(durable, c);
      // Touch it even when nothing changed, so the next run looks at a different one.
      await durable.from('relay_campaigns').update({ updated_at: new Date().toISOString() }).eq('id', c.id);
    }
  }

  return report;
}

/** Nobody left waiting → the broadcast is done. */
async function finishIfDone(admin: SupabaseClient, c: CampaignRow): Promise<void> {
  const queued = await countStatus(admin, c.id, 'queued');
  if (queued > 0) return;
  const at = new Date().toISOString();
  await admin.from('relay_campaigns')
    .update({ status: 'done', finished_at: at, updated_at: at }).eq('id', c.id).eq('status', 'sending');
  await refreshCounters(admin, { ...c, status: 'done', finished_at: at });
}
