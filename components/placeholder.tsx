'use client';

import { Users } from 'lucide-react';
import type { RailKey } from './rail';

// Only Team remains unbuilt — everything else on the rail is live.
export function Placeholder({ nav }: { nav: RailKey }) {
  if (nav !== 'team') return <div style={{ flex: 1, background: 'var(--bg)' }} />;
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 30 }}>
      <div style={{ textAlign: 'center', maxWidth: 340 }}>
        <div style={{ width: 54, height: 54, borderRadius: 15, background: 'var(--surface)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 15px', color: 'var(--muted)' }}>
          <Users size={23} strokeWidth={1.6} />
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 7 }}>Team</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 14px' }}>
          Who is online, who owns which conversation, and response times. Next phase.
        </p>
      </div>
    </div>
  );
}
