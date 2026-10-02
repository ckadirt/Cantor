import React, { useMemo } from 'react';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';

/** KNOBS — the fermata beside a line of mono (`flow.html`'s `#ferm`). */
export const FERMATA_KNOBS = {
  WIDTH_PX: 13,
  HEIGHT_PX: 9,
  /** Between the fermata and the words it holds. */
  GAP_PX: 5,
  STROKE_PX: 0.75,
} as const;

/**
 * The fermata: *held*, waiting and not broken (`folio-steps.md` rule 7). An
 * arc over a dot, set before a state line in that line's own ink. Drawn, not
 * typed: the mono face has no U+1D110.
 */
export function Fermata({ colour }: { colour: string }) {
  const { WIDTH_PX: w, HEIGHT_PX: h, STROKE_PX } = FERMATA_KNOBS;
  const { arc, dot } = useMemo(() => {
    // The drawing's 24 × 16 box, scaled to the glyph.
    const sx = w / 24;
    const sy = h / 16;
    const arcPath = Skia.PathBuilder.Make();
    arcPath.moveTo(2 * sx, 14 * sy);
    arcPath.cubicTo(2 * sx, 3 * sy, 22 * sx, 3 * sy, 22 * sx, 14 * sy);
    const dotPath = Skia.PathBuilder.Make();
    dotPath.addCircle(12 * sx, 11.2 * sy, 1.8 * Math.min(sx, sy) * 1.2);
    return { arc: arcPath.detach(), dot: dotPath.detach() };
  }, [h, w]);
  return (
    <Canvas
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: w, height: h, marginRight: FERMATA_KNOBS.GAP_PX }}
    >
      <Path
        color={colour}
        path={arc}
        strokeCap="round"
        strokeWidth={STROKE_PX}
        style="stroke"
      />
      <Path color={colour} path={dot} />
    </Canvas>
  );
}
