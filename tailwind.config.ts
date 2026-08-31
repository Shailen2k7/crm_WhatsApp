import type { Config } from 'tailwindcss';

// Colours live as CSS variables in globals.css (ported from the Relay design
// canvas) so light/dark switch by swapping one attribute, never by re-rendering.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        teal: 'var(--teal)',
        'teal-2': 'var(--teal-2)',
        'teal-ink': 'var(--teal-ink)',
        'teal-bg': 'var(--teal-bg)',
        amber: 'var(--amber)',
        'amber-bg': 'var(--amber-bg)',
        red: 'var(--red)',
        'red-bg': 'var(--red-bg)',
      },
      fontFamily: { sans: ['Hanken Grotesk', 'system-ui', '-apple-system', 'sans-serif'] },
    },
  },
  plugins: [],
};
export default config;
