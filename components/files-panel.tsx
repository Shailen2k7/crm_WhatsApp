'use client';

// =============================================================================
// FILES — every document and photo across every WhatsApp chat, in one place.
// For an immigration consultancy this is the drawer of CVs, passports and bank
// statements. Each row downloads directly and jumps to its conversation.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { FileText, Image as ImageIcon, Download, MessageSquare, Music, Film, Trash2 } from 'lucide-react';
import type { RelayMessage } from '@/lib/messages';
import type { Contact } from '@/lib/contacts';

type Kind = 'all' | 'document' | 'image' | 'other';

function fmtBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  const [kind, setKind] = useState<Kind>('all');
  const [loading, setLoading] = useState(true);

  // Deletes the message AND its file from storage — the same admin-only route
  // the chat uses, so there is exactly one deletion path to trust.
  async function removeFile(f: RelayMessage) {
    if (!confirm(`Delete "${f.media_name || 'this file'}" permanently?\n\nIt is removed from the chat and from storage.`)) return;
    const res = await fetch(`/api/whatsapp/conversation/${f.conversation_id}?messageId=${f.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.ok) setFiles((prev) => prev.filter((x) => x.id !== f.id));
    else alert(json.error || 'Could not delete.');
  }

  const byConversation = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts) if (c.conversationId) m.set(c.conversationId, c);
    return m;
  }, [contacts]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('relay_messages')
        .select('*')
        .eq('workspace_id', workspaceId)
        .not('media_type', 'is', null)
        .order('created_at', { ascending: false })
        .limit(300);
      if (!cancelled) { setFiles((data || []) as RelayMessage[]); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [supabase, workspaceId]);

  const visible = files.filter((f) => {
    if (kind === 'all') return true;
    if (kind === 'document') return f.media_type === 'document';
    if (kind === 'image') return f.media_type === 'image';
    return f.media_type !== 'document' && f.media_type !== 'image';
  });

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
          Every file sent or received on WhatsApp — CVs, passports, statements — archived and downloadable.
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

        {visible.map((f) => {
          const owner = byConversation.get(f.conversation_id);
          const Icon = f.media_type === 'image' ? ImageIcon : f.media_type === 'audio' ? Music : f.media_type === 'video' ? Film : FileText;
          return (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 14px', marginBottom: 8 }}>
              {f.media_type === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/whatsapp/media/${f.id}`} alt="" loading="lazy" style={{ width: 42, height: 42, borderRadius: 9, objectFit: 'cover', flex: 'none' }} />
              ) : (
                <div style={{ width: 42, height: 42, borderRadius: 9, background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--teal)', flex: 'none' }}>
                  <Icon size={18} />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.media_name || (f.media_type === 'image' ? 'Photo' : 'Attachment')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {(owner ? (owner.unknown ? owner.phoneE164 : owner.name) : 'Unknown chat')}
                  {' · '}{f.direction === 'in' ? 'received' : 'sent'}
                  {' · '}{new Date(f.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  {f.media_size ? ' · ' + fmtBytes(f.media_size) : ''}
                </div>
              </div>
              {owner && (
                <button onClick={() => onOpenChat(owner.key)} aria-label="Open chat" title="Open chat" style={{ width: 32, height: 32, borderRadius: 9, border: 0, background: 'var(--surface-2)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}>
                  <MessageSquare size={15} />
                </button>
              )}
              <a href={`/api/whatsapp/media/${f.id}?download`} aria-label="Download" title="Download" style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--teal-bg)', color: 'var(--teal-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <Download size={15} />
              </a>
              {isAdmin && (
                <button onClick={() => removeFile(f)} aria-label="Delete file" title="Delete file (permanent)" style={{ width: 32, height: 32, borderRadius: 9, border: 0, background: 'var(--red-bg)', color: 'var(--red)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
