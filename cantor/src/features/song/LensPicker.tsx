import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LENSES } from '../../lenses';
import { space, type, usePalette } from '../../theme/tokens';

type Props = {
  activeKey: string;
  onChange: (key: string) => void;
};

/**
 * KNOBS — the picker's row, and the air it may reach into.
 *
 * The row is drawn; the target is slop around it. They were one number — a box
 * `touch.min` tall with the words centred in it — and that box was 48 px of
 * control wrapped around 8 px of ink, in a foot where the transport sits 28 px
 * above and the player's quiet line 22 px below. It overlapped both, it was
 * drawn last so it won both, and a tap on the bottom of the play triangle
 * changed the lens instead of playing the song.
 *
 * So the row hugs its ink and the slop is directional, and both directions are
 * bounded by a neighbour rather than chosen: up stops short of the transport's
 * `SONG_TRANSPORT_HIT_PX` box, down stops short of the quiet line's. That
 * leaves a 30 px band, which is under `touch.min` and is the honest size of the
 * gap the picker has to live in. `songFoot.test.ts` holds all three bands
 * apart; if the picker needs a finger's full 48 it needs to leave the foot,
 * because three controls of that size do not fit between the transport's ink
 * and the bottom edge.
 */
export const LENS_PICKER_KNOBS = {
  /**
   * The row's own height: one line of eyebrow type, stated rather than
   * measured, so the seat above it and the line below it can be compared with
   * it as plain numbers.
   */
  ROW_PX: 16,
  /** Toward the transport, and stopping under it. */
  HIT_UP_PX: 12,
  /** Toward the quiet line, and stopping above it. */
  HIT_DOWN_PX: 2,
  /** Sideways, where a six-letter word is thin and nothing is beside it. */
  HIT_SIDE_PX: space.md,
} as const;

/**
 * One control, at L2, that changes how every song is drawn.
 *
 * There is deliberately not a picker per level: a lens is how the library is
 * being read, not a property of a distance, so changing it here re-skins the
 * marks at L0 and the rows at L1 as well. Its contents come from the registry,
 * so a new lens appears here without touching this file.
 */
function LensPickerImpl({ activeKey, onChange }: Props) {
  const pal = usePalette();
  return (
    <View style={styles.row}>
      {LENSES.map(lens => {
        const active = lens.key === activeKey;
        return (
          <Pressable
            accessibilityLabel={`Draw songs as ${lens.label}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={lens.key}
            onPress={() => onChange(lens.key)}
            hitSlop={{
              top: LENS_PICKER_KNOBS.HIT_UP_PX,
              bottom: LENS_PICKER_KNOBS.HIT_DOWN_PX,
              left: LENS_PICKER_KNOBS.HIT_SIDE_PX,
              right: LENS_PICKER_KNOBS.HIT_SIDE_PX,
            }}
            style={styles.chip}>
            {/*
              A word, not a box. At L2 the song is the picture and the chrome is
              a line of small capitals — the same vocabulary the dials use, and
              the reason this picker stopped being two bordered buttons sitting
              under the ring.
            */}
            <Text
              style={[type.eyebrow, { color: active ? pal.ink : pal.faint }]}
              numberOfLines={1}>
              {lens.label.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' },
  chip: { height: LENS_PICKER_KNOBS.ROW_PX, justifyContent: 'center' },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const LensPicker = React.memo(LensPickerImpl);
