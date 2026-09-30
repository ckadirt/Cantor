import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  PaintStyle,
  Picture,
  Skia,
  createPicture,
} from '@shopify/react-native-skia';
import {
  ARRIVING_NONE,
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  type Availability,
  type Lens,
} from '../../lenses';
import type { FaceRecipe } from '../../lenses/face';
import { type as textType, type Palette } from '../../theme/tokens';

/**
 * KNOBS — the key to the field's ink.
 *
 * The marks are the lens's own, drawn at a little under their field size, so
 * the key reads as a key and not as four songs.
 */
export const LEGEND_KNOBS = {
  MARK_SIZE: 0.8,
  /** The canvas each mark stands in: the mark's reach, and air for the ring. */
  MARK_BOX_PX: 16,
  HAIRLINE_PX: 1,
  GAP_PX: 5,
  ITEM_GAP_PX: 14,
} as const;

/**
 * What the four marks mean, in the words the rows use for them
 * (`availabilityLine`): grey outline, black outline, filled — and the imported
 * spindle, which is always filled because an imported file is always here.
 */
const ENTRIES: readonly Readonly<{
  availability: Availability;
  imported: boolean;
  label: string;
}>[] = [
  { availability: 'not-synced', imported: false, label: 'ON NODE' },
  { availability: 'cached', imported: false, label: 'CACHED' },
  { availability: 'downloaded', imported: false, label: 'DOWNLOADED' },
  { availability: 'downloaded', imported: true, label: 'IMPORTED' },
];

/** A fixed face, so the key shows the same four marks every time. */
const SAMPLE: FaceRecipe = {
  seed: 7,
  id: 'legend',
  model: 'legend',
  durationMs: 120_000,
};

/**
 * The key to the marks, in whichever lens the field is drawn with.
 *
 * One `<Canvas>` under the whole row, not one per mark: a canvas outside the
 * field is a TextureView the window composites on every frame it draws, and
 * the header and foot animate on every level change (the R5a trap in
 * `docs/refactor/field-rewrite-log.md`). The words are laid out by React; the
 * marks are drawn where each word's item says it starts.
 */
export function FieldLegend({
  lens,
  palette,
}: {
  lens: Lens;
  palette: Palette;
}) {
  const [starts, setStarts] = useState<readonly number[]>(() =>
    ENTRIES.map(() => -1),
  );
  const onItemLayout = useCallback(
    (index: number) => (event: LayoutChangeEvent) => {
      const x = event.nativeEvent.layout.x;
      setStarts(current =>
        current[index] === x
          ? current
          : current.map((value, at) => (at === index ? x : value)),
      );
    },
    [],
  );
  const picture = useMemo(() => {
    const fill = Skia.Paint();
    fill.setAntiAlias(true);
    fill.setColor(Skia.Color(palette.ink));
    const stroke = Skia.Paint();
    stroke.setAntiAlias(true);
    stroke.setColor(Skia.Color(palette.ink));
    stroke.setStyle(PaintStyle.Stroke);
    const box = LEGEND_KNOBS.MARK_BOX_PX;
    const identities = ENTRIES.map(entry =>
      lens.identity({
        ...SAMPLE,
        ...(entry.imported ? { imported: true } : {}),
      }),
    );
    return createPicture(canvas => {
      ENTRIES.forEach((entry, index) => {
        if (starts[index] < 0) return;
        canvas.save();
        canvas.translate(starts[index] + box / 2, box / 2);
        lens.ui.drawMark(
          canvas,
          identities[index],
          LEGEND_KNOBS.MARK_SIZE,
          1,
          FACE_STROKE_ALPHA[entry.availability],
          FACE_FILL_ALPHA[entry.availability],
          0,
          ARRIVING_NONE,
          LEGEND_KNOBS.HAIRLINE_PX,
          { fill, stroke },
        );
        canvas.restore();
      });
    });
  }, [lens, palette.ink, starts]);
  return (
    <View
      accessible
      accessibilityLabel="Grey outline: on the node. Black outline: cached. Filled: downloaded. Filled with a dot: imported."
      style={styles.row}
    >
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Picture picture={picture} />
      </Canvas>
      {ENTRIES.map((entry, index) => (
        <View
          key={entry.label}
          onLayout={onItemLayout(index)}
          style={styles.item}
        >
          <View style={styles.mark} />
          <Text style={[styles.word, { color: palette.faint }]}>
            {entry.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: LEGEND_KNOBS.ITEM_GAP_PX,
    height: LEGEND_KNOBS.MARK_BOX_PX,
    justifyContent: 'center',
  },
  item: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: LEGEND_KNOBS.GAP_PX,
  },
  mark: {
    height: LEGEND_KNOBS.MARK_BOX_PX,
    width: LEGEND_KNOBS.MARK_BOX_PX,
  },
  word: { ...textType.eyebrow, fontSize: 9, letterSpacing: 1.4 },
});
