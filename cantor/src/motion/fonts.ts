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
import { useWindowDimensions, type TextStyle } from 'react-native';
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

/**
 * A TextStyle as RN <Text> will actually lay it out: Android scales fontSize,
 * lineHeight and letterSpacing by the system font scale, and Skia does not.
 * Anything that draws a line and then hands it to a real <Text> has to draw
 * at this size, or the glyphs jump at the hand-off on any phone whose font
 * size is not the default.
 */
export function useFontScaledStyle(style: TextStyle, allowFontScaling = true): TextStyle {
  const { fontScale: systemScale } = useWindowDimensions();
  const fontScale = allowFontScaling ? systemScale : 1;
  return useMemo(
    () =>
      fontScale === 1
        ? style
        : {
            ...style,
            fontSize: (style.fontSize ?? 14) * fontScale,
            lineHeight: style.lineHeight === undefined ? undefined : style.lineHeight * fontScale,
            letterSpacing:
              style.letterSpacing === undefined ? undefined : style.letterSpacing * fontScale,
          },
    [style, fontScale],
  );
}
