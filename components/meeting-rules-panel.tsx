'use client';

// =============================================================================
// MEETINGS — two switches: PC1 when a call is booked, PC2 when it is completed.
// -----------------------------------------------------------------------------
// The rules live in relay_automations like the new-lead one and ride the same
// 2-minute tick, so there is nothing new to schedule. Each card shows the
// switch, the template that goes out, and the last few results by name —
// including every meeting the engine could NOT message and why, because a
// person whose booking form had no phone number is a person somebody needs to
// call, not a number on a dashboard.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Loader2, CheckCircle2, AlertTriangle, PlayCircle, CalendarCheck, PhoneCall } from 'lucide-react';
import type { RelayTemplate } from '@/lib/messages';

interface Rule {
  id: string; key: 'meeting_booked' | 'meeting_completed';
  enabled: boolean; template_name: string | null; template_language: string;
  delay_seconds: number; daily_cap: number; activated_at: string | null;
}
interface SentRow {
  id: string; automation_key: string; meeting_id: string | null; phone_e164: string;
  ok: boolean; error: string | null; sent_at: string; client_name?: string;
}

const COPY = {
  meeting_booked: {
    title: 'When a call is booked',
    line: 'The moment a consultation is booked — by you or by the client on the booking page — they get this on WhatsApp. The branded confirmation email already goes out separately.',
    Icon: CalendarCheck,
  },
  meeting_completed: {
    title: 'When a call is marked completed',
    line: 'The moment you mark a meeting completed in the CRM, they get this on WhatsApp and the thank-you email. Only calls that actually happened in the last three days — an old meeting tidied up later is left alone.',
    Icon: PhoneCall,
  },
} as const;

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 20, marginBottom: 16, boxShadow: 'var(--shadow)' };
const select: React.CSSProperties = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, outline: 'none', maxWidth: '100%' };
const spin: React.CSSProperties = { animation: 'spin .8s linear infinite' };

export function MeetingRulesPanel({ workspaceId, templates }: { workspaceId: string; templates: RelayTemplate[] }) {
  const supabase = useMemo(() => createClient(), []);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [sent, setSent] = useState<SentRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      supabase.from('relay_automations').select('*').eq('workspace_id', workspaceId).in('key', ['meeting_booked', 'meeting_completed']),
      supabase.from('relay_automation_sent').select('id, automation_key, meeting_id, phone_e164, ok, error, sent_at')
        .eq('workspace_id', workspaceId).in('automation_key', ['meeting_booked', 'meeting_completed'])
        .order('sent_at', { ascending: false }).limit(40),
    ]);
    const rows = (s.data || []) as SentRow[];
    const ids = [...new Set(rows.map((x) => x.meeting_id).filter(Boolean))] as string[];
    if (ids.length) {
      const { data: ms } = await supabase.from('meetings').select('id, client_name').in('id', ids);
      const names = new Map((ms || []).map((m) => [m.id, m.client_name as string]));
      for (const x of rows) x.client_name = (x.meeting_id && names.get(x.meeting_id)) || undefined;
    }
    setRules((r.data || []) as Rule[]);
    setSent(rows);
  }, [supabase, workspaceId]);

  useEffect(() => { load(); }, [load]);

  async function patch(rule: Rule, fields: Partial<Rule>) {
    setBusy(rule.id);
    setRules((prev) => (prev || []).map((x) => x.id === rule.id ? { ...x, ...fields } : x));
    const { error } = await supabase.from('relay_automations')
      .update({ ...fields, updated_at: new Date().toISOString() }).eq('id', rule.id);
    if (error) { setRunNote({ tone: 'error', text: `Could not save: ${error.message}` }); await load(); }
    setBusy(null);
  }

  /** ON stamps activated_at = NOW so only meetings from this moment on are touched. */
  function toggle(rule: Rule) {
    patch(rule, rule.enabled ? { enabled: false } : { enabled: true, activated_at: new Date().toISOString() });
  }

  async function runNow() {
    setBusy('run'); setRunNote({ tone: 'info', text: 'Running the engine now…' });
    try {
      const res = await fetch('/api/automation/tick', { method: 'POST' });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!j.ok) { setRunNote({ tone: 'error', text: j.error || 'The run failed.' }); }
      else {
        const mine = (j.report || []).filter((r: { key: string }) => r.key === 'meeting_booked' || r.key === 'meeting_completed');
        const lines: string[] = [];
        for (const r of mine) {
          const label = r.key === 'meeting_booked' ? 'Booked' : 'Completed';
          if (r.sent) lines.push(`${label}: sent ${r.sent}.`);
          else if (r.note) lines.push(`${label}: ${r.note}`);
          if (Array.isArray(r.skipped) && r.skipped.length) lines.push(...r.skipped.slice(0, 5).map((x: string) => `${label}: ${x}`));
        }
        setRunNote({ tone: 'ok', text: lines.join('\n') || 'Both rules are off, or nothing is waiting.' });
        await load();
      }
    } catch { setRunNote({ tone: 'error', text: 'Could not reach the server.' }); }
    setBusy(null);
  }

  if (!rules) {
    return <div style={{ padding: 30, color: 'var(--muted)', fontSize: 13.5 }}><Loader2 size={15} style={{ ...spin, verticalAlign: -3, marginRight: 8 }} />Loading…</div>;
  }
  if (rules.length === 0) {
    return (
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>Not set up yet</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Run migration <b>119_meeting_messages.sql</b> in Supabase once. It adds the two switches below and the trigger that stamps when a meeting was completed.
        </div>
      </div>
    );
  }

  const order: Rule['key'][] = ['meeting_booked', 'meeting_completed'];
  const sorted = [...rules].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  return (
    <div>
      {sorted.map((rule) => {
        const c = COPY[rule.key];
        const tpl = templates.find((t) => t.name === rule.template_name);
        const rows = sent.filter((x) => x.automation_key === rule.key).slice(0, 8);
        const okCount = sent.filter((x) => x.automation_key === rule.key && x.ok).length;
        const failCount = sent.filter((x) => x.automation_key === rule.key && !x.ok).length;
        return (
          <section key={rule.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <c.Icon size={17} style={{ color: 'var(--green)' }} /> {c.title}
                </div>
                <div style={{ fontSize: 13.2, color: 'var(--muted)', lineHeight: 1.6 }}>{c.line}</div>
              </div>
              <button onClick={() => toggle(rule)} disabled={busy === rule.id || !rule.template_name}
                aria-label={rule.enabled ? 'Turn off' : 'Turn on'}
                title={!rule.template_name ? 'Pick a template first' : rule.enabled ? 'Turn off' : 'Turn on'}
                style={{ width: 52, height: 30, borderRadius: 15, border: 'none', cursor: 'pointer', flexShrink: 0,
                  background: rule.enabled ? 'var(--green)' : 'var(--track)', position: 'relative', transition: 'background .18s',
                  opacity: !rule.template_name ? 0.5 : 1 }}>
                {busy === rule.id
                  ? <Loader2 size={14} style={{ ...spin, position: 'absolute', top: 8, left: 19, color: '#fff' }} />
                  : <span style={{ position: 'absolute', top: 3, left: rule.enabled ? 25 : 3, width: 24, height: 24, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .18s' }} />}
              </button>
            </div>

            <div style={{ marginTop: 14, padding: '10px 13px', borderRadius: 10, background: rule.enabled ? 'var(--green-bg)' : 'var(--bg)', border: '1px solid var(--line)', fontSize: 12.8, fontWeight: 600, color: rule.enabled ? 'var(--green)' : 'var(--muted)' }}>
              {rule.enabled
                ? `ON — every ${rule.key === 'meeting_booked' ? 'booking' : 'completed call'} from ${rule.activated_at ? new Date(rule.activated_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'now'} onwards`
                : 'OFF — nothing is sent'}
            </div>

            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.8, color: 'var(--ink)', fontWeight: 600 }}>WhatsApp template</span>
              <select style={select} value={rule.template_name || ''}
                onChange={(e) => { const t = templates.find((x) => x.name === e.target.value); patch(rule, { template_name: e.target.value || null, template_language: t?.language || 'en' }); }}>
                <option value="">— choose —</option>
                {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              {rule.template_name && !tpl && <span style={{ fontSize: 12, color: '#D97706' }}>not in Relay yet — Templates → Fetch templates</span>}
            </div>
            {tpl?.body && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--bg)', border: '1px solid var(--line)', fontSize: 12.4, color: 'var(--muted)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
                {tpl.body.replace(/\{\{\s*1\s*\}\}/g, 'Rahul').replace(/\{\{\s*\d+\s*\}\}/g, 'Migrizo')}
              </div>
            )}

            {(okCount + failCount) > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12.4, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>
                  Recent · {okCount} sent{failCount ? `, ${failCount} could not be sent` : ''}
                </div>
                {rows.map((x) => (
                  <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', borderBottom: '1px solid var(--line)', fontSize: 12.4 }}>
                    {x.ok ? <CheckCircle2 size={13} style={{ color: 'var(--green)', flexShrink: 0 }} /> : <AlertTriangle size={13} style={{ color: 'var(--red)', flexShrink: 0 }} />}
                    <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{x.client_name || x.phone_e164}</span>
                    {x.ok ? <span style={{ color: 'var(--muted)' }}>{x.phone_e164}</span> : <span style={{ color: 'var(--red)' }}>{x.error}</span>}
                    <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5 }}>{new Date(x.sent_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <section style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={runNow} disabled={!!busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy === 'run' ? <Loader2 size={15} style={spin} /> : <PlayCircle size={15} />}
            {busy === 'run' ? 'Running…' : 'Run now'}
          </button>
          <span style={{ fontSize: 12.4, color: 'var(--muted)' }}>Otherwise the engine checks every 2 minutes on its own.</span>
        </div>
        {runNote && (
          <div role="status" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.6, padding: '10px 13px', borderRadius: 10,
            background: runNote.tone === 'ok' ? 'var(--green-bg)' : runNote.tone === 'error' ? 'rgba(239,68,68,.10)' : 'var(--bg)',
            border: `1px solid ${runNote.tone === 'ok' ? 'var(--green)' : runNote.tone === 'error' ? 'var(--red)' : 'var(--line)'}`, color: 'var(--ink)' }}>
            {runNote.text}
          </div>
        )}
      </section>
    </div>
  );
}
