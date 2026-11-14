// =============================================================================
// BROADCASTS — the list, and the one door every new broadcast goes through.
// -----------------------------------------------------------------------------
// GET   every broadcast, newest first, with its counters.
//
// POST  { action: 'draft' | 'send' | 'schedule', … }
//         draft     saves what has been written so far; messages nobody.
//         send      builds the list of people and starts sending now.
//         schedule  builds the list now and starts at `scheduledAt`.
//
// WHO GETS IT IS DECIDED HERE, not in the browser: the selection is applied to
// a fresh read of the CRM at the moment of launch. The page says how many
// people it showed (`expectedCount`); if the fresh list is a different size,
// nothing is sent and the page asks again with the new number — nobody ever
// confirms "87 people" and reaches 112.
//
// The list is frozen at launch: someone who turns Hot an hour later does not
// join a broadcast already under way. STOP is the exception — it is checked
// again at the moment each message goes.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isConfigured } from '@/lib/interakt';
import { getStageMeta } from '@/lib/types';
import { broadcastCaller } from '@/lib/broadcast/auth';
import { describeSpec, normaliseSpec, selectAudience } from '@/lib/broadcast/audience';
import { loadBroadcastPeople } from '@/lib/broadcast/people';
import { fetchLiveTemplates, savedTemplates } from '@/lib/broadcast/templates';
import { resolveHeader } from '@/lib/broadcast/send';
import {
  countVars, defaultVariables, missingVariables,
  type BroadcastMeta, type LiveTemplate, type Rate, type VarSpec,
} from '@/lib/broadcast/model';
import { CAMPAIGN_COLS, loadMeta, loadMetas, normaliseMeta, saveMeta, type CampaignRow } from '@/lib/broadcast/engine';
import { summarise } from '@/lib/broadcast/detail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const groupLabel = (g: string) =>
  g === 'spotlight' ? 'Spotlight' : g === 'no_lead' ? 'Not in CRM' : getStageMeta(g).label;

export async function GET() {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const { data, error } = await admin.from('relay_campaigns').select(CAMPAIGN_COLS)
    .eq('workspace_id', who.ws).order('created_at', { ascending: false }).limit(200);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (data || []) as CampaignRow[];
  const metas = await loadMetas(admin, who.ws, rows.map((r) => r.id));
  return NextResponse.json({ ok: true, broadcasts: rows.map((r) => summarise(r, metas.get(r.id))) });
}

export async function POST(req: Request) {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const body = await req.json().catch(() => ({})) as {
    id?: string; action?: string; name?: string; templateName?: string; language?: string;
    spec?: unknown; variables?: VarSpec[]; rate?: Rate; quietHours?: boolean;
    scheduledAt?: string; expectedCount?: number;
  };
  const action = body.action === 'send' || body.action === 'schedule' ? body.action : 'draft';
  const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
    NextResponse.json({ ok: false, error, ...extra }, { status });

  const name = String(body.name || '').trim().slice(0, 120);
  const templateName = String(body.templateName || '').trim();
  const spec = normaliseSpec(body.spec as never);
  const rate: Rate = body.rate === 'fast' || body.rate === 'gentle' ? body.rate : 'normal';
  const quietHours = body.quietHours !== false;
  const launching = action !== 'draft';

  if (launching && !isConfigured()) return bad('WhatsApp is not connected — INTERAKT_API_KEY is not set.', 503);
  if (launching && !name) return bad('Give the broadcast a name, so you can find it later.');
  if (launching && !templateName) return bad('Choose the message to send.');

  // ---- an existing draft being saved again or launched --------------------------
  // The page names the broadcast (a UUID it made up) before the first save, so
  // a double click is the SAME broadcast twice — and the second one is refused
  // below — never two broadcasts to the same people.
  const givenId = String(body.id || '').trim().toLowerCase();
  if (givenId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(givenId)) return bad('Bad broadcast id.');
  let existing: CampaignRow | null = null;
  if (givenId) {
    const { data } = await admin.from('relay_campaigns').select(CAMPAIGN_COLS).eq('id', givenId).maybeSingle();
    existing = (data as CampaignRow) || null;
    if (existing && existing.workspace_id !== who.ws) return bad('That broadcast belongs to another workspace.', 404);
    if (existing && existing.status !== 'draft') return bad('This broadcast has already been launched.', 409, { id: existing.id });
    // A draft with started_at set is being launched right now by another click
    // (see LAUNCH MARK below). A mark older than two minutes is a launch that died.
    if (existing?.started_at && Date.now() - new Date(existing.started_at).getTime() < 120_000) {
      return bad('This broadcast is already being launched.', 409, { id: existing.id });
    }
  }

  // ---- the template, as Interakt has it right now --------------------------------
  let tpl: LiveTemplate | null = null;
  if (templateName) {
    const live = await fetchLiveTemplates();
    const list = live.ok ? live.templates : await savedTemplates(admin, who.ws);
    tpl = list.find((t) => t.name === templateName && (!body.language || t.language === body.language))
      || list.find((t) => t.name === templateName) || null;
    if (launching) {
      if (!live.ok) return bad(`${live.error} A broadcast is only launched against Interakt's live list.`, 502);
      if (!tpl) return bad(`Interakt has no approved template called “${templateName}”. Press Refresh on the template list.`);
      if (tpl.blocked) return bad(tpl.blocked);
      if (!tpl.body) return bad('That template has no wording.');
    }
  }
  const varCount = tpl ? countVars(tpl.body) : 0;
  const variables = defaultVariables(varCount, Array.isArray(body.variables) ? body.variables : []);
  if (launching) {
    const missing = missingVariables(variables, varCount);
    if (missing.length) return bad(`Fill in {{${missing[0]}}} — WhatsApp refuses a message with an empty blank.`);
    const { missing: headerMissing } = await resolveHeader(admin, tpl!.name, tpl!.header);
    if (headerMissing) return bad(`“${tpl!.name}” needs its file (PDF or image) and none is set up. Add it in Files → template headers.`);
  }

  let scheduledAt: string | null = null;
  if (action === 'schedule') {
    const t = new Date(String(body.scheduledAt || '')).getTime();
    if (Number.isNaN(t)) return bad('Choose a date and time to send.');
    if (t < Date.now() + 60_000) return bad('That time has already passed — choose a later one, or send now.');
    if (t > Date.now() + 90 * 86_400_000) return bad('Schedule it within the next 90 days.');
    scheduledAt = new Date(t).toISOString();
  }

  // ---- who gets it: a fresh read, decided here ------------------------------------
  let recipients: { lead_id: string | null; phone_e164: string; full_name: string }[] = [];
  if (launching) {
    let loaded;
    try { loaded = await loadBroadcastPeople(admin, who.ws); }
    catch (e) { return bad(e instanceof Error ? e.message : 'Could not read the CRM.', 500); }
    const result = selectAudience(loaded.people, spec, Date.now(), loaded.stopPhones);
    if (!result.included.length) return bad('Nobody matches that selection any more — nothing was sent.');
    if (typeof body.expectedCount === 'number' && body.expectedCount !== result.included.length) {
      return bad(
        `The list changed while you were writing: it is now ${result.included.length} people, not ${body.expectedCount}.`,
        409, { code: 'count_changed', count: result.included.length },
      );
    }
    recipients = result.included.map((p) => ({ lead_id: p.leadId, phone_e164: p.phone, full_name: p.name }));
  }

  // ---- the campaign row (always created as a draft; flipped only once complete) --
  const nowIso = new Date().toISOString();
  const fields = {
    name: name || 'Untitled broadcast',
    // The column is NOT NULL; a draft with no template yet holds an empty name.
    template_name: tpl?.name || templateName || '',
    template_language: tpl?.language || body.language || 'en',
    audience: 'selected',
    // LAUNCH MARK: while the list of people is being written, the draft carries
    // started_at. A second click that arrives meanwhile sees it and is refused,
    // so the list can never be rebuilt under a broadcast that has begun sending.
    started_at: launching ? nowIso : null,
    updated_at: nowIso,
  };
  /** Takes the launch mark off again when a launch does not go through. */
  const unmark = (campaignId: string) =>
    admin.from('relay_campaigns').update({ started_at: null }).eq('id', campaignId).eq('status', 'draft');
  let id: string;
  if (existing) {
    // Only ONE request may take a draft forward: the update is conditional on
    // the row being exactly as it was read a moment ago.
    const { data: took, error } = await admin.from('relay_campaigns').update(fields)
      .eq('id', existing.id).eq('status', 'draft').eq('updated_at', existing.updated_at).select('id');
    if (error) return bad(error.message, 500);
    if (!took?.length) return bad('This broadcast is already being saved or launched from another click.', 409, { id: existing.id });
    id = existing.id;
  } else {
    const { data, error } = await admin.from('relay_campaigns')
      .insert({ ...fields, ...(givenId ? { id: givenId } : {}), workspace_id: who.ws, status: 'draft', created_by: who.user.id })
      .select('id').single();
    if (error || !data) {
      const dup = /duplicate key/i.test(error?.message || '');
      return bad(dup ? 'This broadcast is already being saved or launched from another click.' : error?.message || 'Could not save the broadcast.', dup ? 409 : 500);
    }
    id = data.id as string;
  }

  const prev = existing ? await loadMeta(admin, who.ws, existing.id) : null;
  const meta: BroadcastMeta = normaliseMeta({
    ...(prev || {}),
    spec, variables, rate, quietHours,
    header: tpl?.header || null,
    body: tpl?.body || '',
    paceAnchorAt: action === 'send' ? nowIso : null,
    healthFrom: action === 'send' ? nowIso : null,
    pausedReason: null,
    createdByName: prev?.createdByName || who.name,
    audienceLabel: describeSpec(spec, groupLabel),
  });
  const metaErr = await saveMeta(admin, who.ws, id, meta);
  if (metaErr) {
    if (!existing) await admin.from('relay_campaigns').delete().eq('id', id);
    else await unmark(id);
    return bad(`Could not save the broadcast: ${metaErr}`, 500);
  }

  if (!launching) return NextResponse.json({ ok: true, id, status: 'draft' });

  // ---- the people, then — and only then — the status that lets it send -----------
  // Anything left from an earlier attempt that failed half way.
  await admin.from('relay_campaign_recipients').delete().eq('campaign_id', id);
  for (let i = 0; i < recipients.length; i += 500) {
    const rows = recipients.slice(i, i + 500).map((r) => ({ ...r, campaign_id: id, workspace_id: who.ws, status: 'queued' }));
    const { error } = await admin.from('relay_campaign_recipients').insert(rows);
    if (error) {
      // Half a list is worse than none: undo, and say so.
      await admin.from('relay_campaign_recipients').delete().eq('campaign_id', id);
      await unmark(id);
      return bad(`Could not save the list of people (${error.message}). Nothing was sent — it is saved as a draft.`, 500, { id });
    }
  }

  const { data: flipped, error: flipErr } = await admin.from('relay_campaigns')
    .update(action === 'send'
      ? { status: 'sending', total: recipients.length, sent: 0, failed: 0, skipped: 0, started_at: nowIso, scheduled_at: null, finished_at: null, updated_at: nowIso }
      : { status: 'scheduled', total: recipients.length, sent: 0, failed: 0, skipped: 0, scheduled_at: scheduledAt, started_at: null, finished_at: null, updated_at: nowIso })
    .eq('id', id).eq('status', 'draft').select('id');
  if (flipErr || !flipped?.length) {
    await unmark(id);
    return bad(flipErr?.message || 'This broadcast was launched from another tab.', 409, { id });
  }

  return NextResponse.json({ ok: true, id, status: action === 'send' ? 'sending' : 'scheduled', count: recipients.length });
}
