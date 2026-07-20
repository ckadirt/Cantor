/**
 * Cantor design tokens — mathematical, minimal, black & white.
 * Paper and ink: light mode is black on white, dark mode is white on black,
 * following the device theme. Grays only for hierarchy; no hue anywhere.
 * (One accent may be introduced later, used almost never.)
 */
import { useColorScheme } from 'react-native';

const light = {
  bg: '#FFFFFF',
  ink: '#000000', // primary content
  muted: '#666666', // secondary text
  faint: '#A6A6A6', // tertiary text, disabled
  line: '#E6E6E6', // hairline rules and borders
};

const dark: Palette = {
  bg: '#000000',
  ink: '#FFFFFF',
  muted: '#999999',
  faint: '#595959',
  line: '#1F1F1F',
};

export type Palette = typeof light;

/** Device-theme-aware palette; re-renders on system light/dark change. */
export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

/** Squares and hairlines; keep radii near zero — this design has corners. */
export const radius = {
  none: 0,
  sm: 2,
} as const;

/**
 * Bundled faces (assets/fonts, mirrored in android/app/src/main/assets/fonts —
 * native rebuild required when they change): 'cmu-serif' = CMU Serif (Computer
 * Modern, the math heritage) for display; 'spectral' = Spectral for body text.
 * Mono stays the system monospace. The Skia text engine resolves the same
 * family names through src/motion/fonts.ts.
 */
export const font = {
  display: 'cmu-serif',
  text: 'spectral',
  mono: 'monospace',
} as const;

export const type = {
  wordmark: { fontFamily: font.display, fontSize: 40, letterSpacing: 0.5 },
  title: { fontFamily: font.display, fontSize: 26, letterSpacing: 0.3 },
  heading: { fontFamily: font.display, fontSize: 20 },
  body: { fontFamily: font.text, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: font.text, fontSize: 13, lineHeight: 18 },
  eyebrow: { fontFamily: font.mono, fontSize: 11, letterSpacing: 2 },
  mono: { fontFamily: font.mono, fontSize: 14 },
} as const;

/** Minimum Android touch target (48dp). */
export const touch = { min: 48 } as const;
