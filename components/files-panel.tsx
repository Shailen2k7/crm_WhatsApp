'use client';

// =============================================================================
// FILES — every document and photo across every WhatsApp chat, in one place.
// For an immigration consultancy this is the drawer of CVs, passports and bank
// statements.
//
// ONE ROW = ONE STORED FILE, not one row per send.
// A brochure sent to forty people is stored ONCE and reused; listing it forty
// times made it look duplicated and invited someone to "clean up" a file that
// quick replies still depended on. So identical sends are grouped, the row says
// how many people got it, and a file a quick reply needs is badged and locked.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { FileText, Image as ImageIcon, Download, MessageSquare, Music, Film, Trash2, Zap, ChevronDown } from 'lucide-react';
import type { RelayMessage } from '@/lib/messages';
import type { Contact } from '@/lib/contacts';

type Kind = 'all' | 'document' | 'image' | 'other';

function fmtBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One stored file, plus every message that sent or received it. */
interface FileGroup {
  key: string;
  path: string | null;
  newest: RelayMessage;
  messages: RelayMessage[];
  usedByQuickReply: string | null;
}

export function FilesPanel({
  workspaceId,
  contacts,
  onOpenChat,
  isAdmin,
}: {
  workspaceId: string;
  contacts: Contact[];
  onOpenChat: (contactKey: string) => void;
  isAdmin: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [files, setFiles] = useState<RelayMessage[]>([]);
  const [qrPaths, setQrPaths] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<Kind>('all');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const byConversation = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts) if (c.conversationId) m.set(c.conversationId, c);
    return m;
  }, [contacts]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [msgs, qrs] = await Promise.all([
        supabase.from('relay_messages').select('*')
          .eq('workspace_id', workspaceId)
          .not('media_type', 'is', null)
          .order('created_at', { ascending: false })
          .limit(400),
        supabase.from('relay_quick_replies').select('shortcut, attachments').eq('workspace_id', workspaceId),
      ]);
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const q of (qrs.data || []) as { shortcut: string; attachments: { path?: string }[] | null }[]) {
        for (const a of q.attachments || []) if (a.path) map[a.path] = q.shortcut;
      }
      setQrPaths(map);
      setFiles((msgs.data || []) as RelayMessage[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, workspaceId]);

  /** Collapse every send of the same stored file into one row. */
  const groups = useMemo<FileGroup[]>(() => {
    const m = new Map<string, FileGroup>();
    for (const f of files) {
      const key = f.media_path || `msg:${f.id}`;
      const g = m.get(key);
      if (g) g.messages.push(f);
      else m.set(key, {
        key,
        path: f.media_path || null,
        newest: f,
        messages: [f],
        usedByQuickReply: f.media_path ? qrPaths[f.media_path] ?? null : null,
      });
    }
    return [...m.values()];
  }, [files, qrPaths]);

  const visible = groups.filter((g) => {
    const t = g.newest.media_type;
    if (kind === 'all') return true;
    if (kind === 'document') return t === 'document';
    if (kind === 'image') return t === 'image';
    return t !== 'document' && t !== 'image';
  });

  /** Deletes every message row for this file, and the file itself — unless a
   *  quick reply still needs it, which the server refuses on its own. */
  async function removeGroup(g: FileGroup) {
    const name = g.newest.media_name || 'this file';
    if (g.usedByQuickReply) {
      alert(`“${name}” is attached to the quick reply /${g.usedByQuickReply}.\n\nRemove it from that quick reply first, otherwise the quick reply would stop working.`);
      return;
    }
    const n = g.messages.length;
    const msg = n > 1
      ? `Delete “${name}” permanently?\n\nIt was sent in ${n} chats — it disappears from all of them, and from storage. It is stored once, so this removes the only copy.`
      : `Delete “${name}” permanently?\n\nIt is removed from the chat and from storage.`;
    if (!confirm(msg)) return;

    for (const f of g.messages) {
      const res = await fetch(`/api/whatsapp/conversation/${f.conversation_id}?messageId=${f.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.ok) { alert(json.error || 'Could not delete.'); return; }
    }
    const ids = new Set(g.messages.map((x) => x.id));
    setFiles((prev) => prev.filter((x) => !ids.has(x.id)));
  }

  const FILTERS: { key: Kind; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'document', label: 'Documents' },
    { key: 'image', label: 'Photos' },
    { key: 'other', label: 'Audio & video' },
  ];

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '28px 20px 60px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Files</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px' }}>
          Every file sent or received on WhatsApp. Each file is stored once — sending it
          to more people does not make another copy.
        </p>

        <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
          {FILTERS.map((f) => {
            const on = kind === f.key;
            return (
              <button key={f.key} onClick={() => setKind(f.key)} style={{ padding: '5px 12px', borderRadius: 99, border: '1px solid ' + (on ? 'transparent' : 'var(--line)'), background: on ? 'var(--teal)' : 'transparent', color: on ? '#fff' : 'var(--ink-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {f.label}
              </button>
            );
          })}
        </div>

        {loading && <div style={{ color: 'var(--muted)', fontSize: 13, padding: 20 }}>Loading…</div>}
        {!loading && visible.length === 0 && (
          <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--muted)' }}>
            <FileText size={26} style={{ marginBottom: 10, opacity: 0.5 }} />
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>No files yet</div>
          </div>
        )}

        {visible.map((g) => {
          const f = g.newest;
          const owner = byConversation.get(f.conversation_id);
          const Icon = f.media_type === 'image' ? ImageIcon : f.media_type === 'audio' ? Music : f.media_type === 'video' ? Film : FileText;
          const many = g.messages.length > 1;
          const expanded = open === g.key;

          return (
            <div key={g.key} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px' }}>
                {f.media_type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/whatsapp/media/${f.id}`} alt="" loading="lazy" style={{ width: 42, height: 42, borderRadius: 9, objectFit: 'cover', flex: 'none' }} />
                ) : (
                  <div style={{ width: 42, height: 42, borderRadius: 9, background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--teal)', flex: 'none' }}>
                    <Icon size={18} />
                  </div>
                )}

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.media_name || (f.media_type === 'image' ? 'Photo' : 'Attachment')}
                    </span>
                    {g.usedByQuickReply && (
                      <span title={`Attached to the quick reply /${g.usedByQuickReply}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none', fontSize: 10.5, fontWeight: 700, color: 'var(--teal-ink)', background: 'var(--teal-bg)', borderRadius: 20, padding: '2px 7px' }}>
                        <Zap size={10} /> /{g.usedByQuickReply}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                    {many
                      ? `Sent in ${g.messages.length} chats`
                      : (owner ? (owner.unknown ? owner.phoneE164 : owner.name) : 'Unknown chat') + ' · ' + (f.direction === 'in' ? 'received' : 'sent')}
                    {' · '}{new Date(f.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    {f.media_size ? ' · ' + fmtBytes(f.media_size) : ''}
                  </div>
                </div>

                {many ? (
                  <button
                    onClick={() => setOpen(expanded ? null : g.key)}
                    aria-label={expanded ? 'Hide chats' : 'Show chats'}
                    title={expanded ? 'Hide chats' : 'Show which chats'}
                    style={{ width: 32, height: 32, borderRadius: 9, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}
                  >
                    <ChevronDown size={15} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
                  </button>
                ) : owner ? (
                  <button onClick={() => onOpenChat(owner.key)} aria-label="Open chat" title="Open chat" style={{ width: 32, height: 32, borderRadius: 9, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}>
                    <MessageSquare size={15} />
                  </button>
                ) : null}

                <a href={`/api/whatsapp/media/${f.id}?download`} aria-label="Download" title="Download" style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--teal-bg)', color: 'var(--teal-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                  <Download size={15} />
                </a>

                {isAdmin && (
                  <button
                    onClick={() => removeGroup(g)}
                    aria-label="Delete file"
                    title={g.usedByQuickReply ? `Locked — used by /${g.usedByQuickReply}` : 'Delete file (permanent)'}
                    style={{ width: 32, height: 32, borderRadius: 9, border: 0, background: g.usedByQuickReply ? 'var(--surface-2)' : 'var(--red-bg)', color: g.usedByQuickReply ? 'var(--muted)' : 'var(--red)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {expanded && (
                <div style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)', padding: '4px 0' }}>
                  {g.messages.map((m) => {
                    const o = byConversation.get(m.conversation_id);
                    return (
                      <button
                        key={m.id}
                        onClick={() => o && onOpenChat(o.key)}
                        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 14px 7px 68px', background: 'none', border: 0, color: 'var(--ink-2)', fontSize: 12.3, cursor: o ? 'pointer' : 'default', textAlign: 'left' }}
                      >
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {o ? (o.unknown ? o.phoneE164 : o.name) : 'Unknown chat'}
                        </span>
                        <span style={{ color: 'var(--muted)', fontSize: 11, flex: 'none' }}>
                          {m.direction === 'in' ? 'received' : 'sent'} · {new Date(m.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
