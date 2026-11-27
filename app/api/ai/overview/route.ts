// =============================================================================
// ASSISTANT — what the Assistant page and the chat header read and change.
// -----------------------------------------------------------------------------
// GET                      the switch, who is waiting for a human, what it did
// GET  ?conversation=<id>  the assistant's status in one chat
// POST { action }          switch / followups (admin) · resume / pause one chat
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { aiCaller } from '@/lib/ai/auth';
import { resumeChat } from '@/lib/ai/engine';
import { loadConfig, loadIndex, loadState, loadStates, saveConfig, saveIndex, saveState } from '@/lib/ai/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function istMidnightMs(): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${today}T00:00:00+05:30`).getTime();
}

export async function GET(req: NextRequest) {
  const who = await aiCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  try {
    const config = await loadConfig(admin, who.ws);
    const one = req.nextUrl.searchParams.get('conversation');
    if (one) {
      if (!UUID.test(one)) return NextResponse.json({ ok: false, error: 'Unknown chat.' }, { status: 400 });
      const s = await loadState(admin, who.ws, one);
      return NextResponse.json({ ok: true, enabled: config.enabled, status: s.status, holdReason: s.holdReason || null, holdAt: s.holdAt || null });
    }

    const idx = await loadIndex(admin, who.ws);
    // A chat given back a moment ago may still be listed by a run that was mid-flight: trust the chat's own record.
    const holdStates = await loadStates(admin, who.ws, Object.keys(idx.holds));
    for (const id of Object.keys(idx.holds)) if (holdStates.get(id)?.status !== 'hold') delete idx.holds[id];
    const ids = [...new Set([...Object.keys(idx.holds), ...idx.activity.slice(-80).map((a) => a.conversationId)])];
    const leadOf = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await admin.from('relay_conversations').select('id, lead_id').in('id', ids.slice(i, i + 100));
      for (const c of (data || []) as { id: string; lead_id: string | null }[]) leadOf.set(c.id, c.lead_id);
    }
    const openKey = (id: string) => leadOf.get(id) || id;
    const since = istMidnightMs();
    const today = { replied: 0, verdicts: 0, booked: 0, handedOver: 0, followUps: 0 };
    for (const a of idx.activity) {
      if (new Date(a.at).getTime() < since) continue;
      if (a.kind === 'replied') today.replied++;
      else if (a.kind === 'verdict') today.verdicts++;
      else if (a.kind === 'booked' || a.kind === 'rescheduled') today.booked++;
      else if (a.kind === 'handed over') today.handedOver++;
      else if (a.kind === 'follow-up') today.followUps++;
    }
    return NextResponse.json({
      ok: true,
      isAdmin: who.isAdmin,
      config,
      keyConfigured: !!process.env.ANTHROPIC_API_KEY,
      problem: idx.problem || null,
      today,
      holds: Object.entries(idx.holds)
        .map(([conversationId, h]) => ({ conversationId, openKey: openKey(conversationId), ...h }))
        .sort((a, b) => b.at.localeCompare(a.at)),
      activity: idx.activity.slice(-80).reverse().map((a) => ({ ...a, openKey: openKey(a.conversationId) })),
      followUpsWaiting: Object.keys(idx.followUps).length,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Could not load.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const who = await aiCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  let body: { action?: string; enabled?: unknown; conversationId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }

  try {
    if (body.action === 'switch' || body.action === 'followups') {
      if (!who.isAdmin) return NextResponse.json({ ok: false, error: 'Only an admin can change this.' }, { status: 403 });
      if (typeof body.enabled !== 'boolean') return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 });
      const config = await loadConfig(admin, who.ws);
      if (body.action === 'followups') config.followUps = body.enabled;
      else {
        if (body.enabled && !process.env.ANTHROPIC_API_KEY) {
          return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY is not set in Netlify, so the assistant cannot think. Add it, redeploy, then switch on.' }, { status: 400 });
        }
        // Switching on starts a clean slate: only messages that arrive from now are answered.
        if (body.enabled && !config.enabled) config.activatedAt = new Date().toISOString();
        config.enabled = body.enabled;
      }
      await saveConfig(admin, who.ws, config);
      return NextResponse.json({ ok: true, config });
    }

    if (body.action === 'resume' || body.action === 'pause') {
      const id = body.conversationId || '';
      if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'Unknown chat.' }, { status: 400 });
      const { data: conv } = await admin.from('relay_conversations').select('id').eq('id', id).eq('workspace_id', who.ws).maybeSingle();
      if (!conv) return NextResponse.json({ ok: false, error: 'Unknown chat.' }, { status: 404 });
      const state = await loadState(admin, who.ws, id);
      const at = new Date().toISOString();
      if (body.action === 'resume') {
        await resumeChat(admin, id, state);
        state.log.push({ at, kind: 'resumed', note: 'A teammate gave this chat back to the assistant.' });
      } else {
        state.status = 'off'; state.plan = undefined; state.claim = undefined;
        state.log.push({ at, kind: 'paused', note: 'A teammate switched the assistant off for this chat.' });
      }
      await saveState(admin, who.ws, id, state);
      const idx = await loadIndex(admin, who.ws);
      if (idx.holds[id]) { delete idx.holds[id]; await saveIndex(admin, who.ws, idx); }
      return NextResponse.json({ ok: true, status: state.status });
    }
    return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Could not save.' }, { status: 500 });
  }
}
