/**
 * Fonts for the Skia text engine. Bundled families load through Metro (works
 * with hot reload, no native rebuild); anything else falls back to the system
 * font manager ('serif', 'monospace', …). RN <Text> resolves the same bundled
 * families from android/app/src/main/assets/fonts/ — same files, two loaders.
 *
 * Everything downstream needs metrics *synchronously*, which is the whole
 * reason MorphText can launch a transition with zero measurement frames.
 */
import { useMemo } from 'react';
import type { TextStyle } from 'react-native';
import { FontStyle, Skia, useTypeface, type SkFont } from '@shopify/react-native-skia';

const BUNDLED: Record<string, number> = {
  'cmu-serif': require('../../assets/fonts/cmu-serif.ttf'),
  spectral: require('../../assets/fonts/spectral.ttf'),
};

/**
 * Resolve a TextStyle's family+size to an SkFont. Returns null only while a
 * bundled face is still streaming in (first app frames); system faces are
 * immediate.
 */
export function useMorphFont(style: TextStyle): SkFont | null {
  const family = style.fontFamily;
  const size = style.fontSize ?? 14;
  const src = (family && BUNDLED[family]) || null;
  const bundled = useTypeface(src);
  return useMemo(() => {
    if (src) {
      return bundled ? Skia.Font(bundled, size) : null;
    }
    const tf = Skia.FontMgr.System().matchFamilyStyle(
      family ?? 'sans-serif',
      FontStyle.Normal,
    );
    return Skia.Font(tf ?? undefined, size);
  }, [src, bundled, family, size]);
}
