// =============================================================================
// COVERAGE API — "has every single lead actually been messaged?"
// -----------------------------------------------------------------------------
// The sequence page already reports audienceTotal and pending, where pending is
// simply audienceTotal minus enrolled. That subtraction hides the thing that
// matters: it counts people the engine can NEVER reach as though they are
// merely waiting their turn. Someone with no phone number, someone who opted
// out, someone already mid-way through another machine — all of them sit in
// "pending" forever and nothing ever says why.
//
// That blindness is exactly how the hot leads went unnoticed. Both sequences
// said audience 'both' and both looked healthy, while 47 hot leads sat in a
// gap neither machine could reach.
//
// So this endpoint refuses to subtract. It puts every lead in the audience into
// exactly ONE bucket and names the people in the small ones, so the question
// "who have we not messaged, and why" has a literal answer on screen.
//
//   messaged          at least one message actually went out
//   waiting           enrolled, first message still scheduled
//   exited            replied / completed / stopped / skipped
//   queued            reachable, not yet enrolled — the engine will get to them
//   unreachable       no phone / unusable phone / opted out / busy elsewhere /
//                     industry filtered — named, because each needs a decision
//
// messaged + waiting + exited + queued + unreachable === total. Always.
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase
    .from('workspace_members').select('workspace_id, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active membership.' }, { status: 403 }) };
  }
  const admin = createAdminClient();
  if (!admin) return { error: NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 }) };
  return { ws: member.workspace_id as string, admin };
}

/** Read a whole table in pages; counts here must be exact, not capped at 1000. */
async function pageAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 40; page++) {
    const { data } = await run(page * 1000, page * 1000 + 999);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

interface Person { id: string; name: string; phone: string | null }

export async function GET(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { ws, admin } = a;

  const id = req.nextUrl.searchParams.get('id');
  let q = admin.from('relay_sequences').select('*').eq('workspace_id', ws).order('created_at').limit(1);
  if (id) q = admin.from('relay_sequences').select('*').eq('workspace_id', ws).eq('id', id).limit(1);
  const { data: seqRows } = await q;
  const seq = seqRows?.[0];
  if (!seq) return NextResponse.json({ ok: false, error: 'No sequence.' }, { status: 404 });

  // The no-reply chase picks its people from who ignored the first message,
  // not from a stage. Coverage of a lead database is not a meaningful question
  // for it, and pretending otherwise would put a wrong number on screen.
  if ((seq.trigger_mode || 'backlog') === 'no_reply') {
    return NextResponse.json({
      ok: true, applicable: false,
      reason: 'This machine follows up people who never replied, so it has no fixed audience to cover.',
    });
  }

  const stages: string[] = seq.audience === 'both' ? ['cold', 'hot'] : [seq.audience];
  const industries: string[] | null = seq.industries ?? null;

  const [leads, mine, elsewhere, suppressed, sends] = await Promise.all([
    pageAll<{ id: string; full_name: string; phone: string | null; industry: string | null; is_sample: boolean | null; created_at: string }>(
      (f, t) => admin.from('leads')
        .select('id, full_name, phone, industry, is_sample, created_at')
        .eq('workspace_id', ws).in('stage', stages)
        .order('created_at', { ascending: true }).range(f, t)),
    pageAll<{ lead_id: string | null; phone_e164: string; status: string; current_step: number }>(
      (f, t) => admin.from('relay_lead_sequences')
        .select('lead_id, phone_e164, status, current_step')
        .eq('sequence_id', seq.id).range(f, t)),
    pageAll<{ lead_id: string | null; phone_e164: string }>(
      (f, t) => admin.from('relay_lead_sequences')
        .select('lead_id, phone_e164')
        .eq('workspace_id', ws).eq('status', 'active').neq('sequence_id', seq.id).range(f, t)),
    pageAll<{ phone_e164: string }>(
      (f, t) => admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws).range(f, t)),
    pageAll<{ lead_id: string | null }>(
      (f, t) => admin.from('relay_sequence_sends')
        .select('lead_id').eq('sequence_id', seq.id).eq('ok', true).range(f, t)),
  ]);

  const mineByLead = new Map(mine.filter((m) => m.lead_id).map((m) => [m.lead_id as string, m]));
  const minePhones = new Set(mine.map((m) => m.phone_e164));
  const busyLeads = new Set(elsewhere.map((e) => e.lead_id).filter(Boolean) as string[]);
  const busyPhones = new Set(elsewhere.map((e) => e.phone_e164));
  const stopPhones = new Set(suppressed.map((s) => s.phone_e164));
  const sentLeads = new Set(sends.map((s) => s.lead_id).filter(Boolean) as string[]);

  const industryOk = (ind: string | null) =>
    !industries || industries.includes((ind || '').trim() || '(none)');

  const b = {
    messaged: 0,
    waiting: 0,
    exited: { replied: 0, completed: 0, stopped: 0, skipped: 0 },
    queued: 0,
  };
  const unreachable = {
    noPhone: [] as Person[],
    badPhone: [] as Person[],
    optedOut: [] as Person[],
    busyElsewhere: [] as Person[],
    industryFiltered: [] as Person[],
  };

  let total = 0;
  for (const l of leads) {
    if (l.is_sample) continue;
    total++;
    const who: Person = { id: l.id, name: l.full_name, phone: l.phone };

    // Already in this machine: report where they got to. This comes first,
    // because someone we have already messaged is covered regardless of what
    // their phone or industry looks like today.
    const row = mineByLead.get(l.id);
    if (row) {
      if (sentLeads.has(l.id)) b.messaged++;
      else if (row.status === 'active') b.waiting++;
      else if (row.status in b.exited) b.exited[row.status as keyof typeof b.exited]++;
      else b.waiting++;
      continue;
    }

    // Not in this machine. Why not?
    const raw = (l.phone || '').trim();
    if (!raw) { unreachable.noPhone.push(who); continue; }
    const e164 = toE164(raw);
    if (!e164) { unreachable.badPhone.push(who); continue; }
    if (stopPhones.has(e164)) { unreachable.optedOut.push(who); continue; }
    if (busyLeads.has(l.id) || busyPhones.has(e164)) { unreachable.busyElsewhere.push(who); continue; }
    if (!industryOk(l.industry)) { unreachable.industryFiltered.push(who); continue; }
    // A different lead row carrying the same number is already enrolled: the
    // person hears from us once, which is right, but this row is not "queued".
    if (minePhones.has(e164)) { unreachable.busyElsewhere.push(who); continue; }
    b.queued++;
  }

  const unreachableTotal =
    unreachable.noPhone.length + unreachable.badPhone.length + unreachable.optedOut.length +
    unreachable.busyElsewhere.length + unreachable.industryFiltered.length;

  const exitedTotal = b.exited.replied + b.exited.completed + b.exited.stopped + b.exited.skipped;
  const covered = b.messaged + b.waiting + exitedTotal;

  return NextResponse.json({
    ok: true,
    applicable: true,
    audience: seq.audience,
    total,
    messaged: b.messaged,
    waiting: b.waiting,
    exited: b.exited,
    exitedTotal,
    queued: b.queued,
    covered,
    unreachableTotal,
    // Named, capped so a huge cold audience cannot make the response enormous.
    // The counts above are always complete; only these lists are trimmed.
    unreachable: {
      noPhone: unreachable.noPhone.slice(0, 100),
      badPhone: unreachable.badPhone.slice(0, 100),
      optedOut: unreachable.optedOut.slice(0, 100),
      busyElsewhere: unreachable.busyElsewhere.slice(0, 100),
      industryFiltered: unreachable.industryFiltered.slice(0, 100),
    },
    unreachableCounts: {
      noPhone: unreachable.noPhone.length,
      badPhone: unreachable.badPhone.length,
      optedOut: unreachable.optedOut.length,
      busyElsewhere: unreachable.busyElsewhere.length,
      industryFiltered: unreachable.industryFiltered.length,
    },
    // The single number the page leads with: reachable people not yet in.
    // Zero means everybody who can be messaged, has been.
    stillToGo: b.queued,
  });
}
