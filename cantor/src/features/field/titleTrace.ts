import { Skia, type SkPath } from '@shopify/react-native-skia';
import { writePhase, writeSubAlpha } from '../../motion/text';

/** Batch a title's strokes without changing the per-glyph Write gesture. */
export function traceTitlePath(paths: readonly SkPath[], written: number): SkPath {
  'worklet';
  const result = Skia.Path.Make();
  for (let index = 0; index < paths.length; index++) {
    const end = writePhase(writeSubAlpha(written, index, paths.length)).borderEnd;
    if (end <= 0) continue;
    if (end >= 1) {
      result.addPath(paths[index]);
    } else {
      // trim mutates its receiver; the canonical outlines must survive reverse
      // playback and the next regrouping unchanged.
      const partial = paths[index].copy();
      partial.trim(0, end, false);
      result.addPath(partial);
      partial.dispose();
    }
  }
  return result;
}
