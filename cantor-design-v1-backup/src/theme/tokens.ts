/**
 * Cantor design tokens — "chalk & brass".
 * Deep blue-slate ground, chalk text, hairline rules, one brass accent.
 * Dark-first; a light scheme can be added by swapping this object behind
 * the same keys, so no component should ever hardcode a hex value.
 */
export const color = {
  bg: '#101216', // blue-black slate, not pure black
  surface: '#191C22', // cards, inputs
  raised: '#20242C', // pressed / emphasized surfaces
  line: '#2A2E36', // hairline rules and borders
  chalk: '#ECEAE4', // primary text, warm chalk white
  dust: '#8B8F98', // secondary text
  faint: '#565B64', // tertiary text, disabled
  brass: '#D9A441', // the single accent — actions, progress, highlights
  brassDim: '#8A6A2E', // accent on dark surfaces / borders
  danger: '#C4574E', // failures, destructive actions
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
} as const;

/**
 * Android maps 'serif' → Noto Serif, 'monospace' → a mono system face.
 * Display = headings and the wordmark; mono = anything identity- or
 * data-shaped (the sixteen words, seeds, durations, counts).
 */
export const font = {
  display: 'serif',
  mono: 'monospace',
} as const;

export const type = {
  wordmark: { fontFamily: font.display, fontSize: 40, letterSpacing: 1 },
  title: { fontFamily: font.display, fontSize: 26, letterSpacing: 0.3 },
  heading: { fontFamily: font.display, fontSize: 20 },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  eyebrow: { fontFamily: font.mono, fontSize: 11, letterSpacing: 2 },
  mono: { fontFamily: font.mono, fontSize: 14 },
} as const;

/** Minimum Android touch target (48dp). */
export const touch = { min: 48 } as const;
