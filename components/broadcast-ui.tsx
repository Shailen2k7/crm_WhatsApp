'use client';

// Small shared pieces of the Broadcast page: buttons, chips, the status pill,
// the WhatsApp-style preview bubble, and a fetch that always returns JSON.
import type { CSSProperties, ReactNode } from 'react';
import { Loader2, Paperclip } from 'lucide-react';
import { getStageMeta } from '@/lib/types';
import type { BroadcastStatus, TemplateHeader } from '@/lib/broadcast/model';

export async function api<T = Record<string, unknown>>(
  url: string, init?: RequestInit,
): Promise<T & { ok: boolean; error?: string; code?: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init?.headers,
      cache: 'no-store',
    });
    const j = await res.json().catch(() => null);
    if (j && typeof j === 'object') return j as T & { ok: boolean; error?: string };
    return { ok: false, error: `The server answered ${res.status} with no detail.` } as T & { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: 'Could not reach the server — check your connection and try again.' } as T & { ok: boolean; error?: string };
  }
}

export function groupLabel(g: string): string {
  if (g === 'spotlight') return 'Spotlight';
  if (g === 'no_lead') return 'Not in CRM';
  if (g === 'lost') return 'Lost';
  if (g === 'unknown') return 'No stage';
  return getStageMeta(g).label;
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

export const num = (n: number) => n.toLocaleString('en-IN');

export function Btn({
  children, onClick, kind = 'soft', disabled, busy, title, small, style,
}: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'soft' | 'ghost' | 'danger';
  disabled?: boolean; busy?: boolean; title?: string; small?: boolean; style?: CSSProperties;
}) {
  const palette: Record<string, CSSProperties> = {
    primary: { background: 'var(--teal)', color: '#fff', border: '1px solid var(--teal)' },
    soft: { background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)' },
    ghost: { background: 'transparent', color: 'var(--ink-2)', border: '1px solid transparent' },
    danger: { background: 'var(--surface)', color: 'var(--red)', border: '1px solid var(--line)' },
  };
  const off = disabled || busy;
  return (
    <button
      type="button" onClick={off ? undefined : onClick} disabled={off} title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        height: small ? 30 : 38, padding: small ? '0 11px' : '0 15px', borderRadius: 10,
        fontSize: small ? 12 : 13, fontWeight: 650, cursor: off ? 'default' : 'pointer',
        opacity: off ? 0.55 : 1, whiteSpace: 'nowrap', flex: 'none', fontFamily: 'inherit',
        ...palette[kind], ...style,
      }}
    >
      {busy && <Loader2 size={14} style={{ animation: 'spin .8s linear infinite' }} />}
      {children}
    </button>
  );
}

/** A toggle chip with an optional count. */
export function Chip({
  on, onClick, children, count, muted, title,
}: { on: boolean; onClick: () => void; children: ReactNode; count?: number; muted?: boolean; title?: string }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on} title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 12px', borderRadius: 99,
        border: '1px solid ' + (on ? 'var(--teal)' : 'var(--line)'),
        background: on ? 'var(--teal-bg)' : 'var(--surface)',
        color: on ? 'var(--teal-ink)' : muted ? 'var(--muted)' : 'var(--ink-2)',
        fontSize: 12.5, fontWeight: on ? 700 : 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >
      {children}
      {typeof count === 'number' && (
        <span style={{ fontSize: 11, fontWeight: 700, color: on ? 'var(--teal-ink)' : 'var(--muted)', opacity: on ? 0.85 : 1 }}>{num(count)}</span>
      )}
    </button>
  );
}

const STATUS: Record<BroadcastStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: 'Draft', bg: 'var(--surface-3)', fg: 'var(--ink-2)' },
  scheduled: { label: 'Scheduled', bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  sending: { label: 'Sending', bg: 'var(--teal-bg)', fg: 'var(--teal-ink)' },
  paused: { label: 'Paused', bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  done: { label: 'Sent', bg: 'var(--green-bg)', fg: 'var(--green)' },
  cancelled: { label: 'Cancelled', bg: 'var(--surface-3)', fg: 'var(--muted)' },
};

export function StatusPill({ status }: { status: BroadcastStatus }) {
  const s = STATUS[status] || STATUS.draft;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, padding: '0 9px', borderRadius: 99, background: s.bg, color: s.fg, fontSize: 11, fontWeight: 750, letterSpacing: '.01em', whiteSpace: 'nowrap' }}>
      {status === 'sending' && <span style={{ width: 6, height: 6, borderRadius: 99, background: 'currentColor', animation: 'pulseDot 1.2s ease infinite' }} />}
      {s.label}
    </span>
  );
}

export function SectionCard({ step, title, hint, children, right }: { step?: number; title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 16px 18px', boxShadow: 'var(--shadow-sm)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: hint ? 3 : 12 }}>
        {step && (
          <span style={{ width: 22, height: 22, borderRadius: 99, background: 'var(--teal)', color: '#fff', fontSize: 11.5, fontWeight: 800, display: 'grid', placeItems: 'center', flex: 'none' }}>{step}</span>
        )}
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 750, color: 'var(--ink)', flex: 1 }}>{title}</h3>
        {right}
      </div>
      {hint && <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, paddingLeft: step ? 32 : 0 }}>{hint}</p>}
      {children}
    </section>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 750, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '0 0 7px' }}>{children}</div>;
}

export const inputStyle: CSSProperties = {
  height: 38, padding: '0 11px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)',
  color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit', outline: 'none', minWidth: 0,
};

export function Note({ tone, children }: { tone: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const c = {
    info: ['var(--surface-2)', 'var(--ink-2)'], warn: ['var(--amber-bg)', 'var(--amber)'],
    error: ['var(--red-bg)', 'var(--red)'], ok: ['var(--green-bg)', 'var(--green)'],
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : undefined} style={{ background: c[0], color: c[1], borderRadius: 10, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.5, fontWeight: 550 }}>
      {children}
    </div>
  );
}

/** WhatsApp's *bold*, _italic_ and ~strike~, shown the way the phone shows them. */
export function waRich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const inner = m[0].slice(1, -1);
    const mark = m[0][0];
    out.push(
      mark === '*' ? <strong key={i++}>{inner}</strong>
        : mark === '_' ? <em key={i++}>{inner}</em>
          : <s key={i++}>{inner}</s>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The message as it lands on a phone. */
export function PhonePreview({
  body, header, footer, buttons, empty,
}: { body: string; header: TemplateHeader | null; footer?: string | null; buttons?: string[]; empty?: string }) {
  return (
    <div style={{ background: 'var(--chat)', border: '1px solid var(--line)', borderRadius: 14, padding: 14, minHeight: 120 }}>
      {!body ? (
        <div style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: '26px 8px', lineHeight: 1.5 }}>{empty || 'Choose a message to see it here.'}</div>
      ) : (
        <div style={{ maxWidth: 320, marginLeft: 'auto' }}>
          <div style={{ background: 'var(--out-bg)', color: 'var(--out-fg)', borderRadius: '14px 14px 4px 14px', padding: '9px 11px 8px', boxShadow: 'var(--shadow-sm)' }}>
            {header && header.format !== 'TEXT' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.16)', borderRadius: 9, padding: '8px 10px', marginBottom: 8, fontSize: 12, fontWeight: 650 }}>
                <Paperclip size={14} style={{ flex: 'none' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {header.fileName || (header.format === 'IMAGE' ? 'Image' : header.format === 'VIDEO' ? 'Video' : 'Document')}
                </span>
              </div>
            )}
            <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{waRich(body)}</div>
            {footer && <div style={{ fontSize: 11.5, opacity: 0.75, marginTop: 6 }}>{footer}</div>}
          </div>
          {!!buttons?.length && (
            <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
              {buttons.map((b, i) => (
                <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', textAlign: 'center', fontSize: 12.5, fontWeight: 650, color: 'var(--teal)' }}>{b}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
