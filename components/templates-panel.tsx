'use client';

// =============================================================================
// APPROVED TEMPLATES — the messages Meta allows outside the 24-hour window.
// -----------------------------------------------------------------------------
// Interakt has no working API to LIST templates (verified: their
// /track/templates/ endpoint returns 500 on every request shape), so each
// approved template is registered here once — name, language, and the approved
// body with its {{1}} {{2}} placeholders. Sending uses Interakt's documented
// template-send API, which does work.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Plus, Trash2, Pencil, Loader2, LayoutTemplate, RefreshCw, ClipboardPaste } from 'lucide-react';
import type { RelayTemplate } from '@/lib/messages';

const emptyDraft = { id: '', name: '', language: 'en', body: '', category: '' };

export function TemplatesPanel({ workspaceId }: { workspaceId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<RelayTemplate[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState('');
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  // Tries Interakt's importer. It is broken on their side today (HTTP 500 to
  // every request shape), but the button stays: the day they fix it this starts
  // working with no change here, and until then it reports their real response
  // rather than leaving you to wonder.
  async function syncFromInterakt() {
    setSyncing(true); setSyncNote(null);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const j = await res.json();
      setSyncNote(j.ok ? j.note : j.error);
      if (j.ok) load();
    } catch {
      setSyncNote('Could not reach the server.');
    }
    setSyncing(false);
  }

  /**
   * Bulk paste. One template per block:
   *
   *   code_name | en | UTILITY
   *   Hi {{1}}, thanks for your interest in the UK Global Talent Visa.
   *
   * Blocks separated by a blank line. Faster than filling the form ten times.
   */
  async function importBulk() {
    // SPLIT ON HEADER LINES, NOT BLANK LINES.
    //
    // Real approved templates contain blank lines — they are several paragraphs
    // long. Splitting the paste on blank lines therefore tore each template
    // apart and stored only its first paragraph. A header line is unambiguous:
    // "name | language | category", or just a bare template code on its own
    // line. Everything until the NEXT header belongs to that template's body.
    const lines = bulk.split('\n');

    // Table noise from a dashboard copy-paste: status words, categories,
    // language names, dates and row buttons. Never part of a body.
    const NOISE = /^(approved|pending|rejected|draft|in review|marketing|utility|authentication|english|english \(us\)|edit|delete|duplicate|view|actions?|name|status|category|language|type)$/i;

    const isHeader = (ln: string): boolean => {
      const t = ln.trim();
      if (!t || NOISE.test(t)) return false;
      if (t.includes('|')) return /^[\w.-]+\s*\|/.test(t);        // name | en | CATEGORY
      if (t.includes('\t')) return /^[a-z0-9][\w.-]{0,40}\t/i.test(t); // name<TAB>UTILITY<TAB>Approved
      return /^[a-z0-9][\w.-]{0,40}$/i.test(t) && !/\s/.test(t);   // a bare code like "t2"
    };

    /** Splits a header into name / language / category, whatever the separator. */
    const readHeader = (ln: string) => {
      const parts = ln.trim().split(/\s*[|\t]\s*/).filter(Boolean);
      const name = parts[0];
      const rest = parts.slice(1);
      const lang = rest.find((x) => /^[a-z]{2}(_[A-Z]{2})?$/.test(x))
        || (rest.some((x) => /^english/i.test(x)) ? 'en' : '')
        || 'en';
      const cat = rest.find((x) => /^(marketing|utility|authentication)$/i.test(x))?.toUpperCase() || null;
      return { name, language: lang, category: cat };
    };

    const rows: { workspace_id: string; name: string; language: string; category: string | null; body: string; variable_count: number }[] = [];
    let cur: { name: string; language: string; category: string | null; body: string[] } | null = null;

    const flush = () => {
      if (!cur) return;
      const body = cur.body.join('\n').trim();
      if (cur.name && body) {
        rows.push({
          workspace_id: workspaceId,
          name: cur.name,
          language: cur.language || 'en',
          category: cur.category,
          body,
          variable_count: countVars(body),
        });
      }
      cur = null;
    };

    for (const ln of lines) {
      if (isHeader(ln)) {
        flush();
        const h = readHeader(ln);
        cur = { name: h.name, language: h.language, category: h.category, body: [] };
      } else if (cur) {
        if (!NOISE.test(ln.trim())) cur.body.push(ln);
      }
    }
    flush();

    if (rows.length === 0) {
      setBulkNote('Could not read any template. Each one needs a header line — "t2 | en | UTILITY" or just "t2" — followed by its body.');
      return;
    }

    const { error: err } = await supabase
      .from('relay_templates')
      .upsert(rows, { onConflict: 'workspace_id,name,language' });
    if (err) { setBulkNote(err.message); return; }

    let repaired = 0;
    for (const r of rows) repaired += await backfill(r.name, r.body);

    setBulk(''); setBulkOpen(false); setBulkNote(null);
    setSyncNote(
      `Imported ${rows.length} template${rows.length === 1 ? '' : 's'} (${rows.map((r) => r.name).join(', ')}).` +
      (repaired > 0 ? ` ${repaired} past message${repaired === 1 ? '' : 's'} now show the real wording.` : '')
    );
    load();
  }

  async function load() {
    const { data } = await supabase
      .from('relay_templates')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('sort_order')
      .order('name');
    if (data) setItems(data as RelayTemplate[]);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);

  function countVars(body: string): number {
    const m = body.match(/\{\{\s*(\d+)\s*\}\}/g) || [];
    return new Set(m.map((x) => x.replace(/\D/g, ''))).size;
  }

  async function save() {
    const name = draft.name.trim();
    // The BODY IS OPTIONAL. Interakt needs only the name, language and variable
    // values to send; the body is for previewing here. Requiring it was my
    // mistake and it blocked sending for no reason.
    if (!name) {
      setError('A template needs its exact code name from Interakt.');
      return;
    }
    setSaving(true); setError(null);
    const row = {
      workspace_id: workspaceId,
      name,
      language: draft.language.trim() || 'en',
      body: draft.body.trim(),
      category: draft.category.trim() || null,
      variable_count: countVars(draft.body),
    };
    const q = draft.id
      ? supabase.from('relay_templates').update(row).eq('id', draft.id)
      : supabase.from('relay_templates').insert(row);
    const { error: err } = await q;
    if (err) {
      setSaving(false);
      setError(err.message.includes('duplicate') ? `"${name}" (${row.language}) is already registered.` : err.message);
      return;
    }

    // REPAIR THE HISTORY.
    // Messages sent before the wording was known were recorded as
    // 'Template "t1" · Upen' — accurate but useless as a record of what the
    // client read. Now that the approved text exists, every one of them is
    // re-rendered with its own stored variable values.
    const repaired = await backfill(name, row.body);

    setSaving(false);
    setDraft(emptyDraft); setEditing(false);
    if (repaired > 0) setSyncNote(`Saved. ${repaired} past message${repaired === 1 ? '' : 's'} in your chats now show the real wording.`);
    load();
  }

  /**
   * Re-renders past messages of a template using the newly-known wording and
   * each message's own stored bodyValues. Returns how many were fixed.
   */
  async function backfill(templateName: string, body: string): Promise<number> {
    if (!body.trim()) return 0;
    const { data: msgs } = await supabase
      .from('relay_messages')
      .select('id, body, template_values')
      .eq('workspace_id', workspaceId)
      .eq('template_name', templateName)
      .limit(500);
    if (!msgs?.length) return 0;

    let n = 0;
    for (const m of msgs as { id: string; body: string; template_values: { bodyValues?: string[] } | null }[]) {
      // Only replace placeholders — never overwrite a real message someone typed.
      const isPlaceholder =
        /^\[template:/.test(m.body) || /^Template\s*[“"]/.test(m.body) || m.body.trim() === '';
      if (!isPlaceholder) continue;

      const vals = m.template_values?.bodyValues || [];
      const rendered = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_x, k: string) => vals[Number(k) - 1] || '');
      const { error: uerr } = await supabase.from('relay_messages').update({ body: rendered }).eq('id', m.id);
      if (!uerr) n++;
    }
    return n;
  }

  async function remove(id: string) {
    if (!confirm('Remove this template from Migrizo? (It stays approved in Interakt — this only removes it here.)')) return;
    await supabase.from('relay_templates').delete().eq('id', id);
    load();
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '28px 20px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Templates</h1>
          {!editing && (
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <button onClick={syncFromInterakt} disabled={syncing} style={ghostBtn}>
                {syncing ? <Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={14} />}
                Sync approved templates
              </button>
              <button onClick={() => { setBulkOpen((v) => !v); setBulkNote(null); }} style={ghostBtn}>
                <ClipboardPaste size={14} /> Paste many
              </button>
              <button onClick={() => { setDraft(emptyDraft); setEditing(true); }} style={primaryBtn}>
                <Plus size={15} /> Add template
              </button>
            </div>
          )}
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
          Every template here appears behind the template button in each chat, ready to send in one tap —
          the customer&rsquo;s first name is filled in automatically. These are the only messages WhatsApp
          allows once the 24-hour window has closed.
        </p>

        {/* How to get them in automatically. Interakt's list API has been
            returning HTTP 500 for months, so Meta is the route that works. */}
        <details style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 18 }}>
          <summary style={{ fontSize: 12.8, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' }}>
            Make &ldquo;Sync approved templates&rdquo; pull everything automatically
          </summary>
          <div style={{ fontSize: 12.3, color: 'var(--muted)', lineHeight: 1.7, marginTop: 10 }}>
            Interakt&rsquo;s template list API has been returning an error for months (their bug — sending
            works fine), so we ask Meta directly instead. One-time setup:
            <ol style={{ margin: '9px 0 0', paddingLeft: 20 }}>
              <li>Open <strong>business.facebook.com</strong> &rarr; Settings &rarr; Users &rarr; System users</li>
              <li>Add a system user, then <strong>Generate token</strong> with the
                  <strong> whatsapp_business_management</strong> permission</li>
              <li>In Netlify, add <code>META_ACCESS_TOKEN</code> with that token, and redeploy</li>
            </ol>
            <div style={{ marginTop: 9 }}>
              After that this button imports every approved template — names, wording and placeholders —
              and re-importing keeps them current. Until then, use <strong>Paste many</strong>.
            </div>
          </div>
        </details>

        {syncNote && (
          <div style={{ background: 'var(--amber-bg)', color: 'var(--ink)', padding: '11px 13px', borderRadius: 10, fontSize: 12.3, lineHeight: 1.55, marginBottom: 14 }}>
            {syncNote}
          </div>
        )}

        {bulkOpen && (
          <section className="animate-pop-in" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 18, marginBottom: 20, boxShadow: 'var(--shadow)' }}>
            <label style={label}>Paste your templates — one per block, blank line between them</label>
            <textarea
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              rows={10}
              placeholder={'gtv_welcome_v2 | en | UTILITY\nHi {{1}}, thanks for your interest in the UK Global Talent Visa. Shall we book a quick call?\n\nifv_docs | en | UTILITY\nHi {{1}}, here is the document checklist for the Innovator Founder Visa.'}
              style={{ ...input, resize: 'vertical', lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12.5 }}
            />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '7px 0 12px', lineHeight: 1.55 }}>
              Each template starts with a header line — <strong>code name | language | category</strong>, or just the
              code name on its own line. Everything until the next header is the approved body, blank lines and all.
              You can also select the template table in Interakt and paste it straight in: the row headings,
              &ldquo;Approved&rdquo; labels and category columns are ignored automatically.
            </div>
            {bulkNote && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 500, marginBottom: 10 }}>{bulkNote}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={importBulk} style={primaryBtn}><ClipboardPaste size={14} /> Import</button>
              <button onClick={() => { setBulkOpen(false); setBulk(''); setBulkNote(null); }} style={ghostBtn}>Cancel</button>
            </div>
          </section>
        )}

        {editing && (
          <section className="animate-pop-in" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 18, marginBottom: 20, boxShadow: 'var(--shadow)' }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 2, minWidth: 200 }}>
                <label style={label}>Template code name (exact)</label>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="gtv_welcome_v2" style={input} />
              </div>
              <div style={{ flex: '0 0 90px' }}>
                <label style={label}>Language</label>
                <input value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })} placeholder="en" style={input} />
              </div>
              <div style={{ flex: '0 0 140px' }}>
                <label style={label}>Category</label>
                <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="UTILITY" style={input} />
              </div>
            </div>

            <label style={label}>Approved body — optional, for preview only. Keep {'{{1}}'} placeholders as approved.</label>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={5}
              placeholder={'Hi {{1}}, thanks for your interest in the UK Global Talent Visa…'}
              style={{ ...input, resize: 'vertical', lineHeight: 1.55 }}
            />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 12px' }}>
              {countVars(draft.body)} variable{countVars(draft.body) === 1 ? '' : 's'} detected.
            </div>

            {error && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 500, marginBottom: 10 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={save} disabled={saving} style={primaryBtn}>
                {saving && <Loader2 size={13} style={{ animation: 'spin .8s linear infinite' }} />}
                {draft.id ? 'Save changes' : 'Add template'}
              </button>
              <button onClick={() => { setEditing(false); setDraft(emptyDraft); setError(null); }} style={ghostBtn}>Cancel</button>
            </div>
          </section>
        )}

        {items.length === 0 && !editing && (
          <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--muted)' }}>
            <LayoutTemplate size={26} style={{ marginBottom: 10, opacity: 0.5 }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 5 }}>No templates registered</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 400, margin: '0 auto' }}>
              Add the templates already approved on your Interakt account. Until then, a closed
              24-hour window means a chat cannot be reopened from here.
            </div>
          </div>
        )}

        {items.map((t) => (
          <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, padding: '13px 15px', marginBottom: 9 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--teal-bg)', color: 'var(--teal-ink)' }}>{t.language}</span>
                {t.category && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--surface-3)', color: 'var(--muted)' }}>{t.category}</span>}
                {t.variable_count > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{t.variable_count} variable{t.variable_count === 1 ? '' : 's'}</span>
                )}
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 0', lineHeight: 1.5, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {t.body}
              </p>
            </div>
            <button onClick={() => { setDraft({ id: t.id, name: t.name, language: t.language, body: t.body, category: t.category || '' }); setEditing(true); window.scrollTo({ top: 0 }); }} aria-label="Edit" style={rowBtn}><Pencil size={14} /></button>
            <button onClick={() => remove(t.id)} aria-label="Delete" style={{ ...rowBtn, color: 'var(--red)' }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

const label: React.CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--ink-2)', marginBottom: 5 };
const input: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--surface-2)', outline: 'none', fontSize: 13.5 };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', borderRadius: 9, border: 0, background: 'var(--teal)', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', borderRadius: 9, border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink-2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const rowBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' };
