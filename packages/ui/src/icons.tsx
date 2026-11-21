import type { ReactElement } from 'react';

export type PanelIconName = 'settings' | 'fullscreen' | 'collapse' | 'expand';

/** Small line icons drawn here, so the panel needs no icon font and no emoji glyph. */
export function PanelIcon({ name, size = 16 }: { name: PanelIconName; size?: number }): ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  if (name === 'settings') {
    return (
      <svg {...common} strokeWidth={2}>
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="8.5" strokeWidth={3} strokeLinecap="butt" strokeDasharray="3.3 3.37" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    );
  }
  if (name === 'fullscreen') {
    return (
      <svg {...common} strokeWidth={2}>
        <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
      </svg>
    );
  }
  if (name === 'expand') {
    return (
      <svg {...common} strokeWidth={2}>
        <path d="M6 9l6 6 6-6" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={2}>
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}
