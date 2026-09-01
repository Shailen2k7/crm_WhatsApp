'use client';

// =============================================================================
// QUICK REPLIES — the answers the team types twenty times a day, with files.
// Build them here; use them in any chat by typing "/" in the composer.
// A reply's attachments (fee sheet PDF, document checklist) go out WITH it.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Plus, Trash2, Paperclip, X, Loader2, Zap, Pencil } from 'lucide-react';
import type { QuickReply } from '@/lib/messages';

interface Attachment { path: string; name: string; mime: string; size: number }

const emptyDraft = { id: '', shortcut: '', title: '', body: '', attachments: [] as Attachment[] };

export function QuickRepliesManager({ workspaceId }: { workspaceId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<QuickReply[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from('relay_quick_replies')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('sort_order')
      .order('title');
    if (data) setItems(data as QuickReply[]);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);

  async function uploadFiles(files: FileList | null) {
    if (!files) return;
    setUploading(true); setError(null);
    for (const f of Array.from(files).slice(0, 5)) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        const res = await fetch('/api/whatsapp/upload', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.ok) setDraft((d) => ({ ...d, attachments: [...d.attachments, json.attachment] }));
        else setError(json.error || `Could not upload ${f.name}`);
      } catch { setError(`Could not upload ${f.name}`); }
    }
    setUploading(false);
  }

  async function save() {
    const shortcut = draft.shortcut.trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, '-');
    const title = draft.title.trim();
    if (!shortcut || !title || (!draft.body.trim() && draft.attachments.length === 0)) {
      setError('A quick reply needs a shortcut, a title, and either text or a file.');
      return;
    }
    setSaving(true); setError(null);
    const row = {
      workspace_id: workspaceId,
      shortcut, title,
      body: draft.body.trim(),
      attachments: draft.attachments,
    };
    const q = draft.id
      ? supabase.from('relay_quick_replies').update(row).eq('id', draft.id)
      : supabase.from('relay_quick_replies').insert(row);
    const { error: err } = await q;
    setSaving(false);
    if (err) {
      setError(err.message.includes('duplicate') ? `/${shortcut} already exists — shortcuts must be unique.` : err.message);
      return;
    }
    setDraft(emptyDraft); setEditing(false);
    load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this quick reply? Its files stay usable in any chats that already sent them.')) return;
    await supabase.from('relay_quick_replies').delete().eq('id', id);
    load();
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '28px 20px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Quick replies</h1>
          {!editing && (
            <button onClick={() => { setDraft(emptyDraft); setEditing(true); }} style={primaryBtn}>
              <Plus size={15} /> New quick reply
            </button>
          )}
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 22px' }}>
          Type <strong>/</strong> in any chat to use one. Attached files are sent along with the message.
        </p>

        {editing && (
          <section className="animate-pop-in" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 18, marginBottom: 20, boxShadow: 'var(--shadow)' }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 150px' }}>
                <label style={label}>Shortcut</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--teal)', fontWeight: 700, fontSize: 13 }}>/</span>
                  <input value={draft.shortcut} onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })} placeholder="fees" style={{ ...input, paddingLeft: 22 }} />
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={label}>Title</label>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="GTV fee structure" style={input} />
              </div>
            </div>

            <label style={label}>Message</label>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={4}
              placeholder={'Hi! Here is our Global Talent Visa fee structure…'}
              style={{ ...input, resize: 'vertical', lineHeight: 1.5 }}
            />

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
              {draft.attachments.map((f, i) => (
                <span key={i} style={chip}>
                  <Paperclip size={11} /> {f.name}
                  <button onClick={() => setDraft((d) => ({ ...d, attachments: d.attachments.filter((_, j) => j !== i) }))} aria-label="Remove" style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'inherit', display: 'flex', padding: 0 }}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <label style={{ ...chip, cursor: 'pointer', borderStyle: 'dashed' }}>
                {uploading ? <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> : <Paperclip size={12} />}
                Attach file
                <input type="file" multiple hidden onChange={(e) => uploadFiles(e.target.files)} />
              </label>
            </div>

            {error && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 500, marginBottom: 10 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={save} disabled={saving} style={primaryBtn}>
                {saving && <Loader2 size={13} style={{ animation: 'spin .8s linear infinite' }} />}
                {draft.id ? 'Save changes' : 'Create'}
              </button>
              <button onClick={() => { setEditing(false); setDraft(emptyDraft); setError(null); }} style={ghostBtn}>Cancel</button>
            </div>
          </section>
        )}

        {items.length === 0 && !editing && (
          <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--muted)' }}>
            <Zap size={26} style={{ marginBottom: 10, opacity: 0.5 }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 5 }}>No quick replies yet</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 380, margin: '0 auto' }}>
              Start with the ones an immigration consultancy needs daily: /fees, /docs (document checklist), /book (consultation link), /gtv, /ifv.
            </div>
          </div>
        )}

        {items.map((q) => (
          <div key={q.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 13, padding: '13px 15px', marginBottom: 9 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--teal-ink)' }}>/{q.shortcut}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{q.title}</span>
                {q.attachments?.length > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
                    <Paperclip size={11} /> {q.attachments.length} file{q.attachments.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 0', lineHeight: 1.5, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {q.body}
              </p>
            </div>
            <button onClick={() => { setDraft({ id: q.id, shortcut: q.shortcut, title: q.title, body: q.body, attachments: q.attachments || [] }); setEditing(true); window.scrollTo({ top: 0 }); }} aria-label="Edit" style={rowBtn}><Pencil size={14} /></button>
            <button onClick={() => remove(q.id)} aria-label="Delete" style={{ ...rowBtn, color: 'var(--red)' }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

const label: React.CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--ink-2)', marginBottom: 5 };
const input: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--surface-2)', outline: 'none', fontSize: 13.5 };
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--surface-2)', fontSize: 11.5, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', borderRadius: 9, border: 0, background: 'var(--teal)', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', borderRadius: 9, border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink-2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const rowBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' };
