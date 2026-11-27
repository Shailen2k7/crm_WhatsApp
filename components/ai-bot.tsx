'use client';
// =============================================================================
// A small animated robot for the chat header. Awake (the assistant is on in
// this chat): it floats, its glowing eyes look around the chat and blink, a
// light scans across its visor, its antenna pulses and a sparkle twinkles while
// it thinks. Asleep (held or switched off): grey, eyes closed, a little "z".
// Motion stops for people who ask their system for reduced motion.
// =============================================================================
import { useId } from 'react';

const CSS = `
.aibot { display: block; overflow: visible; flex: none; }
.aibot * { transform-box: fill-box; }
.aibot.awake .b-body { transform-origin: 50% 100%; animation: aibot-float 3s ease-in-out infinite; }
.aibot.awake .b-shadow { transform-origin: 50% 50%; animation: aibot-shadow 3s ease-in-out infinite; }
.aibot.awake .b-eyes { animation: aibot-look 7s ease-in-out infinite; }
.aibot .b-eye { transform-origin: 50% 50%; }
.aibot.awake .b-eye { animation: aibot-blink 4.4s ease-in-out infinite; }
.aibot.awake .b-scan { animation: aibot-scan 3.6s ease-in-out infinite; }
.aibot.awake .b-orb { transform-origin: 50% 50%; animation: aibot-orb 1.8s ease-in-out infinite; }
.aibot.awake .b-halo { transform-origin: 50% 50%; animation: aibot-halo 1.8s ease-out infinite; }
.aibot.awake .b-spark { transform-origin: 50% 50%; animation: aibot-spark 2.4s ease-in-out infinite; }
.aibot.awake .b-spark2 { transform-origin: 50% 50%; animation: aibot-spark 2.4s ease-in-out 1.2s infinite; }
.aibot.awake .b-mouth { animation: aibot-mouth 3s ease-in-out infinite; }
.aibot .b-z { animation: aibot-z 3s ease-in-out infinite; }
@keyframes aibot-float { 0%,100% { transform: translateY(0) rotate(0); } 25% { transform: translateY(-1.1px) rotate(-4deg); } 50% { transform: translateY(-1.5px) rotate(0); } 75% { transform: translateY(-1.1px) rotate(4deg); } }
@keyframes aibot-shadow { 0%,100% { transform: scaleX(1); opacity: .35; } 50% { transform: scaleX(.7); opacity: .18; } }
@keyframes aibot-look { 0%,12% { transform: translate(0,0); } 18%,34% { transform: translate(-1.6px,.2px); } 40%,56% { transform: translate(1.6px,.2px); } 62%,76% { transform: translate(.3px,-.8px); } 84%,100% { transform: translate(0,0); } }
@keyframes aibot-blink { 0%,42%,50%,100% { transform: scaleY(1); } 46% { transform: scaleY(.1); } }
@keyframes aibot-scan { 0% { transform: translateX(-10px); opacity: 0; } 15% { opacity: .9; } 55% { transform: translateX(10px); opacity: 0; } 100% { transform: translateX(10px); opacity: 0; } }
@keyframes aibot-orb { 0%,100% { transform: scale(1); filter: brightness(1); } 50% { transform: scale(1.15); filter: brightness(1.35); } }
@keyframes aibot-halo { 0% { transform: scale(.6); opacity: .8; } 100% { transform: scale(2.4); opacity: 0; } }
@keyframes aibot-spark { 0%,100% { transform: scale(0) rotate(0); opacity: 0; } 40%,60% { transform: scale(1) rotate(45deg); opacity: 1; } }
@keyframes aibot-mouth { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(.6); } }
@keyframes aibot-z { 0% { transform: translate(0,0); opacity: 0; } 30% { opacity: .9; } 100% { transform: translate(2px,-3px); opacity: 0; } }
.aibot-dots { display: inline-flex; gap: 2.5px; align-items: center; height: 10px; margin-left: 1px; }
.aibot-dots i { width: 3.5px; height: 3.5px; border-radius: 99px; background: currentColor; opacity: .25; animation: aibot-dot 1.3s ease-in-out infinite; }
.aibot-dots i:nth-child(2) { animation-delay: .18s; }
.aibot-dots i:nth-child(3) { animation-delay: .36s; }
@keyframes aibot-dot { 0%,60%,100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2.5px); } }
@media (prefers-reduced-motion: reduce) { .aibot *, .aibot-dots i { animation: none !important; } }
`;

export function AiBot({ size = 26, awake = true }: { size?: number; awake?: boolean }) {
  const id = useId().replace(/:/g, '');
  const g = (n: string) => `${n}-${id}`;
  const head = awake ? ['#34d8bd', '#0d8c7c'] : ['#c3cfcb', '#8a9a95'];
  const eye = awake ? '#6dffe6' : '#7f8f8a';
  return (
    <>
      <style>{CSS}</style>
      <svg className={`aibot${awake ? ' awake' : ''}`} width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
        <defs>
          <linearGradient id={g('head')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={head[0]} />
            <stop offset="1" stopColor={head[1]} />
          </linearGradient>
          <linearGradient id={g('visor')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={awake ? '#123a35' : '#3a4643'} />
            <stop offset="1" stopColor={awake ? '#06201c' : '#283330'} />
          </linearGradient>
          <radialGradient id={g('orb')} cx=".35" cy=".35" r=".7">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".45" stopColor={awake ? '#ffd36b' : '#d7dedb'} />
            <stop offset="1" stopColor={awake ? '#ff9f1c' : '#9aa8a4'} />
          </radialGradient>
          <linearGradient id={g('scan')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6dffe6" stopOpacity="0" />
            <stop offset=".5" stopColor="#6dffe6" stopOpacity=".55" />
            <stop offset="1" stopColor="#6dffe6" stopOpacity="0" />
          </linearGradient>
          <filter id={g('glow')} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation=".8" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <clipPath id={g('clip')}><rect x="7" y="11" width="14" height="9.6" rx="4.2" /></clipPath>
        </defs>

        <ellipse className="b-shadow" cx="14" cy="26.6" rx="6.5" ry="1" fill="currentColor" opacity=".3" />

        <g className="b-body">
          {/* antenna */}
          <path d="M14 8.2 V5.4" stroke={head[1]} strokeWidth="1.5" strokeLinecap="round" />
          {awake && <circle className="b-halo" cx="14" cy="3.8" r="2" fill="none" stroke="#ffb63b" strokeWidth=".7" />}
          <circle className="b-orb" cx="14" cy="3.8" r="2" fill={`url(#${g('orb')})`} />

          {/* ears */}
          <rect x="2" y="12.6" width="3" height="6.2" rx="1.5" fill={head[1]} />
          <rect x="23" y="12.6" width="3" height="6.2" rx="1.5" fill={head[1]} />

          {/* head */}
          <rect x="4.2" y="8" width="19.6" height="16.4" rx="6.4" fill={`url(#${g('head')})`} />
          <path d="M8.6 9.4 h10.8" stroke="#fff" strokeOpacity=".45" strokeWidth="1.1" strokeLinecap="round" />

          {/* visor */}
          <rect x="7" y="11" width="14" height="9.6" rx="4.2" fill={`url(#${g('visor')})`} />
          {awake && (
            <g clipPath={`url(#${g('clip')})`}>
              <rect className="b-scan" x="9" y="11" width="10" height="9.6" fill={`url(#${g('scan')})`} />
            </g>
          )}

          {awake ? (
            <>
              <g className="b-eyes" filter={`url(#${g('glow')})`}>
                <rect className="b-eye" x="9.6" y="13.2" width="2.8" height="3.6" rx="1.4" fill={eye} />
                <rect className="b-eye" x="15.6" y="13.2" width="2.8" height="3.6" rx="1.4" fill={eye} />
              </g>
              <path className="b-mouth" d="M12.4 18.6 q1.6 1 3.2 0" stroke={eye} strokeWidth=".9" strokeLinecap="round" fill="none" opacity=".85" />
            </>
          ) : (
            <g stroke={eye} strokeWidth="1.1" strokeLinecap="round" fill="none">
              <path d="M9.6 15.2 q1.4 1 2.8 0" />
              <path d="M15.6 15.2 q1.4 1 2.8 0" />
            </g>
          )}
        </g>

        {awake ? (
          <>
            <path className="b-spark" d="M24.6 4.2 l.55 1.45 1.45 .55 -1.45 .55 -.55 1.45 -.55 -1.45 -1.45 -.55 1.45 -.55z" fill="#ffc94a" />
            <path className="b-spark2" d="M3.6 6.2 l.4 1 1 .4 -1 .4 -.4 1 -.4 -1 -1 -.4 1 -.4z" fill="#6dffe6" />
          </>
        ) : (
          <text className="b-z" x="22.5" y="7" fontSize="6" fontWeight="800" fill="currentColor" fontFamily="inherit">z</text>
        )}
      </svg>
    </>
  );
}

/** Three dots that rise in turn: "thinking". */
export function ThinkingDots() {
  return <span className="aibot-dots" aria-hidden="true"><i /><i /><i /></span>;
}
