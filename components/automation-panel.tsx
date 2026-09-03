'use client';

// =============================================================================
// AUTOMATION — one switch.
// -----------------------------------------------------------------------------
// A new lead enters the CRM  ->  they get the first message asking for CV and
// LinkedIn. Whatever the hour. Once per person, ever.
//
// WhatsApp itself decides which of two forms that message can take: a customer
// who has written to us in the last 24h can receive any message (we send the
// quick reply), and one who has not can only legally receive an approved
// template. That choice is made FOR you at send time — it is not a setting.
// =============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Workflow, Loader2, Play, ShieldCheck, ChevronDown } from 'lucide-react';
import type { QuickReply, RelayTemplate } from '@/lib/messages';
import { SequencePanel } from './sequence-panel';
import { CampaignPanel } from './campaign-panel';

interface Rule {
  id: string;
  enabled: boolean;
  quick_reply_shortcut: string | null;
  template_name: string | null;
  template_language: string;
  delay_seconds: number;
  daily_cap: number;
  activated_at: string | null;
}

export function AutomationPanel({ workspaceId }: { workspaceId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [rule, setRule] = useState<Rule | null>(null);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [templates, setTemplates] = useState<RelayTemplate[]>([]);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<'newlead' | 'sequence' | 'campaign'>('newlead');

  const load = useCallback(async () => {
    const [r, qr, tp] = await Promise.all([
      supabase.from('relay_automations').select('*').eq('workspace_id', workspaceId).eq('key', 'new_lead_first').maybeSingle(),
      supabase.from('relay_quick_replies').select('*').eq('workspace_id', workspaceId).order('sort_order'),
      supabase.from('relay_templates').select('*').eq('workspace_id', workspaceId).order('sort_order'),
    ]);
    if (r.data) setRule(r.data as Rule);
    if (qr.data) setQuickReplies(qr.data as QuickReply[]);
    if (tp.data) setTemplates(tp.data as RelayTemplate[]);
  }, [supabase, workspaceId]);

  useEffect(() => { load(); }, [load]);

  async function patch(fields: Partial<Rule>) {
    if (!rule) return;
    setRule({ ...rule, ...fields });
    await supabase.from('relay_automations')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', rule.id);
  }

  /** ON stamps activated_at = NOW, so only leads arriving from this moment
   *  are ever touched. Switching on can never message your existing database. */
  function toggle() {
    if (!rule) return;
    patch(rule.enabled ? { enabled: false } : { enabled: true, activated_at: new Date().toISOString() });
  }

  async function runNow() {
    setRunning(true); setRunNote(null);
    try {
      const res = await fetch('/api/automation/tick', { method: 'POST' });
      const j = await res.json();
      const r = j.report?.[0];
      if (!j.ok) setRunNote(j.error || 'The run failed.');
      else if (!r) setRunNote(j.note || 'Switch it on first.');
      else {
        const lines: string[] = [];
        if (r.sent) lines.push(`Sent ${r.sent} first message${r.sent === 1 ? '' : 's'}.`);
        if (r.note) lines.push(r.note);
        if (Array.isArray(r.skipped) && r.skipped.length) lines.push(...r.skipped.slice(0, 6));
        setRunNote(lines.join('\n') || 'Nothing waiting — everyone new has already been messaged.');
        load();
      }
    } catch { setRunNote('Could not reach the server.'); }
    setRunning(false);
  }

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 20, marginBottom: 16, boxShadow: 'var(--shadow)' };
  const select: React.CSSProperties = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, outline: 'none', maxWidth: '100%' };

  if (!rule) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--muted)', fontSize: 13.5 }}>
        <span><Loader2 size={15} className="animate-spin" style={{ verticalAlign: -3, marginRight: 8 }} />Loading…</span>
      </div>
    );
  }

  const qr = quickReplies.find((q) => q.shortcut === rule.quick_reply_shortcut);
  const tpl = templates.find((t) => t.name === rule.template_name);
  const ready = !!qr && !!tpl;

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 1160, margin: '0 auto', padding: '26px 20px 60px' }}>
        <h1 style={{ fontSize: 19, fontWeight: 700, color: 'var(--ink)', margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <Workflow size={19} style={{ color: 'var(--green)' }} /> Automation
        </h1>

        {/* the two machines, one tab each */}
        <div style={{ display: 'inline-flex', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 11, padding: 3, marginBottom: 18, boxShadow: 'var(--shadow)' }}>
          {([['newlead', 'New lead'], ['sequence', 'Follow-up sequence'], ['campaign', 'Campaigns']] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                padding: '7px 16px', borderRadius: 9, border: 'none', fontSize: 12.8, fontWeight: 600, cursor: 'pointer',
                background: tab === k ? 'var(--green)' : 'transparent',
                color: tab === k ? '#fff' : 'var(--muted)',
                transition: 'background .15s, color .15s',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>

        {tab === 'campaign' ? <CampaignPanel templates={templates} />
         : tab === 'sequence' ? <SequencePanel templates={templates} /> : (<>

        {/* ── THE SWITCH ─────────────────────────────────────────────────── */}
        <section className="animate-pop-in" style={{ ...card, padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 5 }}>
                Message every new lead
              </div>
              <div style={{ fontSize: 13.4, color: 'var(--muted)', lineHeight: 1.6 }}>
                The moment a lead enters the CRM, they get your first message asking for
                their CV and LinkedIn. Any time of day. Once per person.
              </div>
            </div>
            <button
              onClick={toggle}
              aria-label={rule.enabled ? 'Turn off' : 'Turn on'}
              style={{
                width: 52, height: 30, borderRadius: 15, border: 'none', cursor: 'pointer', flexShrink: 0,
                background: rule.enabled ? 'var(--green)' : 'var(--track)', position: 'relative', transition: 'background .18s',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: rule.enabled ? 25 : 3, width: 24, height: 24,
                borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .18s',
              }} />
            </button>
          </div>

          <div style={{
            marginTop: 16, padding: '10px 13px', borderRadius: 10,
            background: rule.enabled ? 'var(--green-bg)' : 'var(--bg)',
            border: '1px solid var(--line)',
            fontSize: 12.8, fontWeight: 600, color: rule.enabled ? 'var(--green)' : 'var(--muted)',
          }}>
            {rule.enabled
              ? `ON — every lead added from ${rule.activated_at ? new Date(rule.activated_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'now'} onwards`
              : 'OFF — nothing is sent'}
          </div>

          {!ready && (
            <div style={{ marginTop: 12, fontSize: 12.6, color: 'var(--red)', lineHeight: 1.5 }}>
              Pick the message below before switching on.
            </div>
          )}
        </section>

        {/* ── THE MESSAGE THAT GOES OUT ──────────────────────────────────── */}
        <section style={card}>
          <div style={{ fontSize: 13.8, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>What we send</div>
          <div style={{ fontSize: 12.6, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
            WhatsApp only allows a normal message to someone who wrote to us in the last 24 hours.
            Everyone else must get an approved template. We pick the right one automatically —
            you just choose which.
          </div>

          <MessageChoice
            heading="If they have written to us"
            sub="normal message"
            value={rule.quick_reply_shortcut || ''}
            onChange={(v) => patch({ quick_reply_shortcut: v || null })}
            options={quickReplies.map((q) => ({ value: q.shortcut, label: `/${q.shortcut} — ${q.title}` }))}
            preview={qr?.body}
            attachments={(qr?.attachments || []).map((a) => a.name)}
            selectStyle={select}
          />

          <div style={{ height: 14 }} />

          <MessageChoice
            heading="If they have not"
            sub="approved template"
            value={rule.template_name || ''}
            onChange={(v) => {
              const t = templates.find((x) => x.name === v);
              patch({ template_name: v || null, template_language: t?.language || 'en' });
            }}
            options={templates.map((t) => ({ value: t.name, label: t.name }))}
            preview={tpl?.body?.replace(/\{\{\s*1\s*\}\}/g, 'Rahul').replace(/\{\{\s*(\d+)\s*\}\}/g, 'Migrizo')}
            previewNote="shown with a sample name filled in"
            selectStyle={select}
          />
        </section>

        {/* ── SAFETY ─────────────────────────────────────────────────────── */}
        <section style={{ ...card, display: 'flex', gap: 11 }}>
          <ShieldCheck size={17} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.7 }}>
            Nobody is messaged twice — not even if they appear several times in the CRM.
            Only leads added after you switch it on. Anyone who replies <b>STOP</b> is never
            messaged again. Checked every 2 minutes.
          </div>
        </section>

        {/* ── the two knobs almost nobody needs ──────────────────────────── */}
        <button
          onClick={() => setShowSettings((s) => !s)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer', padding: '2px 0', marginBottom: showSettings ? 12 : 20 }}
        >
          <ChevronDown size={13} style={{ transform: showSettings ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
          Advanced
        </button>

        {showSettings && (
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: 'var(--ink)' }}>
              <span>Wait</span>
              <select style={select} value={rule.delay_seconds} onChange={(e) => patch({ delay_seconds: Number(e.target.value) })}>
                {[10, 30, 60].map((sec) => (
                  <option key={sec} value={sec}>{sec < 60 ? `${sec} seconds` : '1 minute'}</option>
                ))}
              </select>
              <span style={{ color: 'var(--muted)' }}>after the lead arrives, in case they message us first.</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: 'var(--ink)', marginTop: 14 }}>
              <span>Never send more than</span>
              <select style={select} value={rule.daily_cap} onChange={(e) => patch({ daily_cap: Number(e.target.value) })}>
                {[10, 20, 50, 100, 200, 500].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span style={{ color: 'var(--muted)' }}>messages a day — a brake in case something goes wrong.</span>
            </div>
          </section>
        )}

        {/* Every automated send lands in the normal chat thread, so a second
            copy of the list here was just noise. What is worth keeping is the
            manual trigger and whatever the last run reported. */}
        <section style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13.4, fontWeight: 700, color: 'var(--ink)' }}>Run it now</div>
            <div style={{ fontSize: 12.2, color: 'var(--muted)', marginTop: 3, lineHeight: 1.55 }}>
              Checks for new leads immediately instead of waiting for the next 2-minute check.
              Messages appear in the customer&rsquo;s chat as usual.
            </div>
          </div>
          <button
            onClick={runNow}
            disabled={running}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: 'none' }}
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Check now
          </button>
          {runNote && (
            <pre style={{ flexBasis: '100%', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', fontSize: 12.4, color: 'var(--ink)', lineHeight: 1.6, margin: 0 }}>{runNote}</pre>
          )}
        </section>
        </>)}
      </div>
    </div>
  );
}

/** A choice of message, with the real wording shown underneath it. */
function MessageChoice({
  heading, sub, value, onChange, options, preview, previewNote, attachments, selectStyle,
}: {
  heading: string; sub: string;
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
  preview?: string | null; previewNote?: string;
  attachments?: string[];
  selectStyle: React.CSSProperties;
}) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: preview ? 11 : 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{heading}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 20, padding: '2px 9px' }}>{sub}</span>
        <select style={{ ...selectStyle, marginLeft: 'auto' }} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— choose —</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {preview && (
        <div style={{
          whiteSpace: 'pre-wrap', fontSize: 12.6, lineHeight: 1.6, color: 'var(--ink)',
          background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: '11px 13px',
        }}>
          {preview}
          {!!attachments?.length && (
            <div style={{ marginTop: 9, fontSize: 11.8, color: 'var(--muted)' }}>
              📎 {attachments.join(', ')}
            </div>
          )}
        </div>
      )}
      {preview && previewNote && (
        <div style={{ fontSize: 11.3, color: 'var(--muted)', marginTop: 6 }}>{previewNote}</div>
      )}
    </div>
  );
}
