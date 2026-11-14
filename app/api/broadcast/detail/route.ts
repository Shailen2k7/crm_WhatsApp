// =============================================================================
// ONE BROADCAST — its results, and the buttons on it.
// -----------------------------------------------------------------------------
// GET  ?id=…   the broadcast with every person's line: waiting, sent,
//              delivered, read, replied, failed (and why), skipped (and why).
//
// POST { id, action }
//   pause         stop sending; the people still waiting stay waiting
//   resume        carry on from where it stopped (pacing starts afresh)
//   send_now      a scheduled broadcast starts immediately
//   cancel        stop for good; whoever was still waiting is marked skipped
//   retry_failed  everyone it failed for goes back in the queue, once
//   settings      { rate, quietHours } — change speed or quiet hours mid-send
//   rename        { name }
//   delete        a draft, or a broadcast that never sent anything
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { broadcastCaller } from '@/lib/broadcast/auth';
import { metaKey, type Rate } from '@/lib/broadcast/model';
import { CAMPAIGN_COLS, loadMeta, normaliseMeta, refreshCounters, saveMeta, type CampaignRow } from '@/lib/broadcast/engine';
import { buildDetail } from '@/lib/broadcast/detail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function find(admin: NonNullable<ReturnType<typeof createAdminClient>>, ws: string, id: string): Promise<CampaignRow | null> {
  if (!UUID.test(id)) return null;
  const { data } = await admin.from('relay_campaigns').select(CAMPAIGN_COLS).eq('id', id).eq('workspace_id', ws).maybeSingle();
  return (data as CampaignRow) || null;
}

export async function GET(req: NextRequest) {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const c = await find(admin, who.ws, req.nextUrl.searchParams.get('id') || '');
  if (!c) return NextResponse.json({ ok: false, error: 'That broadcast no longer exists.' }, { status: 404 });
  try {
    const meta = normaliseMeta(await loadMeta(admin, who.ws, c.id));
    return NextResponse.json({ ok: true, broadcast: await buildDetail(admin, c, meta) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Could not load the results.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const body = await req.json().catch(() => ({})) as {
    id?: string; action?: string; rate?: Rate; quietHours?: boolean; name?: string;
  };
  const c = await find(admin, who.ws, String(body.id || ''));
  if (!c) return NextResponse.json({ ok: false, error: 'That broadcast no longer exists.' }, { status: 404 });
  const bad = (error: string, status = 409) => NextResponse.json({ ok: false, error }, { status });
  const nowIso = new Date().toISOString();
  const meta = normaliseMeta(await loadMeta(admin, who.ws, c.id));

  /** Moves the status only if it is still what we read — two clicks cannot fight. */
  const move = async (from: string[], patch: Record<string, unknown>) => {
    const { data, error } = await admin.from('relay_campaigns')
      .update({ ...patch, updated_at: nowIso }).eq('id', c.id).in('status', from).select('id');
    if (error) return error.message;
    return data?.length ? null : 'It changed a moment ago — refresh and try again.';
  };

  switch (body.action) {
    case 'pause': {
      const err = await move(['sending', 'scheduled'], { status: 'paused' });
      if (err) return bad(err);
      await saveMeta(admin, who.ws, c.id, { ...meta, pausedReason: null });
      break;
    }
    case 'resume': {
      if (c.status !== 'paused') return bad('It is not paused.');
      // Paused before its scheduled time came: it goes back to waiting for it.
      const backToSchedule = !c.started_at && c.scheduled_at && new Date(c.scheduled_at).getTime() > Date.now();
      const err = await move(['paused'], backToSchedule
        ? { status: 'scheduled' }
        : { status: 'sending', started_at: c.started_at || nowIso, finished_at: null });
      if (err) return bad(err);
      await saveMeta(admin, who.ws, c.id, { ...meta, pausedReason: null, paceAnchorAt: nowIso, healthFrom: nowIso });
      break;
    }
    case 'send_now': {
      const err = await move(['scheduled'], { status: 'sending', started_at: nowIso, scheduled_at: null });
      if (err) return bad(err);
      await saveMeta(admin, who.ws, c.id, { ...meta, pausedReason: null, paceAnchorAt: nowIso, healthFrom: nowIso });
      break;
    }
    case 'cancel': {
      const err = await move(['sending', 'scheduled', 'paused'], { status: 'cancelled', finished_at: nowIso });
      if (err) return bad(err);
      await admin.from('relay_campaign_recipients')
        .update({ status: 'skipped', error: 'Cancelled before it was sent.' })
        .eq('campaign_id', c.id).eq('status', 'queued');
      await refreshCounters(admin, { ...c, status: 'cancelled' });
      break;
    }
    case 'retry_failed': {
      if (!['done', 'paused', 'cancelled', 'sending'].includes(c.status)) return bad('Nothing has been sent yet.');
      await refreshCounters(admin, c);   // late refusals become 'failed' first, so they are included
      const { data: again, error } = await admin.from('relay_campaign_recipients')
        .update({ status: 'queued', error: null, message_id: null, sent_at: null })
        .eq('campaign_id', c.id).eq('status', 'failed').select('id');
      if (error) return bad(error.message, 500);
      if (!again?.length) return bad('Nobody failed — there is nothing to retry.');
      if (c.status !== 'sending') {
        const err = await move(['done', 'paused', 'cancelled'], { status: 'sending', finished_at: null, started_at: c.started_at || nowIso });
        if (err) return bad(err);
      }
      await saveMeta(admin, who.ws, c.id, { ...meta, pausedReason: null, paceAnchorAt: nowIso, healthFrom: nowIso });
      await refreshCounters(admin, { ...c, status: 'sending' });
      return NextResponse.json({ ok: true, retried: again.length });
    }
    case 'settings': {
      const rate: Rate = body.rate === 'fast' || body.rate === 'gentle' || body.rate === 'normal' ? body.rate : meta.rate;
      const quietHours = typeof body.quietHours === 'boolean' ? body.quietHours : meta.quietHours;
      // A new speed is measured from now, not from the start — otherwise
      // "Fast" would release everything the slow hours had held back at once.
      await saveMeta(admin, who.ws, c.id, { ...meta, rate, quietHours, paceAnchorAt: rate !== meta.rate ? nowIso : meta.paceAnchorAt });
      break;
    }
    case 'rename': {
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) return bad('A broadcast needs a name.', 400);
      await admin.from('relay_campaigns').update({ name, updated_at: nowIso }).eq('id', c.id);
      break;
    }
    case 'delete': {
      const neverSent = c.status === 'draft' || (c.status === 'cancelled' && c.sent === 0 && c.failed === 0);
      if (!neverSent) return bad('Only a draft, or a broadcast that never sent anything, can be deleted — the others are your record of what went out.');
      const { error } = await admin.from('relay_campaigns').delete().eq('id', c.id);
      if (error) return bad(error.message, 500);
      await admin.from('relay_settings').delete().eq('workspace_id', who.ws).eq('key', metaKey(c.id));
      return NextResponse.json({ ok: true, deleted: true });
    }
    default:
      return bad('Unknown action.', 400);
  }
  return NextResponse.json({ ok: true });
}
