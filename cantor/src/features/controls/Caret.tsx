import React from 'react';
import { StyleSheet, View } from 'react-native';

/** KNOBS — the chevron. */
export const CARET_KNOBS = {
  /**
   * The side of the square whose two sides are drawn. Rotated 45°, a 13 px
   * square reads as a chevron about 18 px across — the size of a word, not the
   * size of a button.
   */
  SIZE_PX: 13,
} as const;

/**
 * A hairline chevron, pointing where the panel it belongs to will go.
 *
 * Two sides of a square, rotated: the same hairline the tick under a dial and
 * the slats on an edge tab are drawn with, so a mark that says "this folds
 * away" is made of the same stroke as everything else in the chrome. It is the
 * app's answer to a word like `TAP TO FOLD` — a control you have already read
 * before you have finished reading it, and one line of text fewer on a sheet
 * whose subject is the one line you are writing.
 */
export function Caret({
  colour,
  direction,
}: {
  colour: string;
  /** Where it points. `up` folds a block away; `down` opens one. */
  direction: 'up' | 'down';
}) {
  return (
    <View
      style={[
        styles.caret,
        { borderColor: colour },
        // 45° is the chevron; the half-turn on top of it is the direction.
        { transform: [{ rotate: direction === 'up' ? '45deg' : '225deg' }] },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  caret: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    height: CARET_KNOBS.SIZE_PX,
    width: CARET_KNOBS.SIZE_PX,
  },
});
