'use client';

import { Star, FileText, LayoutTemplate, Users } from 'lucide-react';
import type { RailKey } from './rail';

// These screens are designed (they exist in the Relay canvas) but depend on
// message data, so they arrive with their phase. Naming the phase is more
// useful than an empty page pretending to be finished.
const COPY: Partial<Record<RailKey, { title: string; body: string; phase: string; Icon: typeof Star }>> = {
  starred: {
    title: 'Starred',
    body: 'Messages you flag to come back to will collect here.',
    phase: 'Phase 3',
    Icon: Star,
  },
  files: {
    title: 'Files',
    body: 'Every CV, passport and document received on WhatsApp, in one searchable place.',
    phase: 'Phase 4',
    Icon: FileText,
  },
  templates: {
    title: 'Templates',
    body: 'Your approved WhatsApp templates and quick replies, insertable with a slash command.',
    phase: 'Phase 2',
    Icon: LayoutTemplate,
  },
  team: {
    title: 'Team',
    body: 'Who is online, who owns which conversation, and how fast each person replies.',
    phase: 'Phase 3',
    Icon: Users,
  },
};

export function Placeholder({ nav }: { nav: RailKey }) {
  const c = COPY[nav];
  if (!c) return <div style={{ flex: 1, background: 'var(--bg)' }} />;
  const { Icon } = c;

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 30 }}>
      <div style={{ textAlign: 'center', maxWidth: 340 }}>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 15,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 15px',
            color: 'var(--muted)',
          }}
        >
          <Icon size={23} strokeWidth={1.6} />
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 7 }}>{c.title}</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 14px' }}>{c.body}</p>
        <span
          style={{
            display: 'inline-block',
            fontSize: 11,
            fontWeight: 700,
            padding: '4px 11px',
            borderRadius: 99,
            background: 'var(--surface-3)',
            color: 'var(--ink-2)',
          }}
        >
          {c.phase}
        </span>
      </div>
    </div>
  );
}
