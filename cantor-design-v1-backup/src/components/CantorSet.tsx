import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { color } from '../theme/tokens';

/**
 * The Cantor set (middle-thirds fractal) as a progress mark.
 *
 * Each row is one recursion depth; `progress` (0..1) reveals rows top to
 * bottom, so generation reads as the set deepening toward infinity.
 * Pure static Views — no animation loop, so it stays cheap while the
 * CPU is saturated by inference.
 */

type Interval = [number, number];

function level(intervals: Interval[]): Interval[] {
  const next: Interval[] = [];
  for (const [a, b] of intervals) {
    const third = (b - a) / 3;
    next.push([a, a + third], [b - third, b]);
  }
  return next;
}

const DEPTH = 6;
const LEVELS: Interval[][] = (() => {
  const all: Interval[][] = [[[0, 1]]];
  for (let i = 1; i < DEPTH; i++) {
    all.push(level(all[i - 1]));
  }
  return all;
})();

type Props = {
  /** 0..1 — how many recursion levels are revealed. Omit for the full set. */
  progress?: number;
  /** Total height of the mark. */
  height?: number;
  barColor?: string;
};

function CantorSetInner({ progress = 1, height = 96, barColor = color.brass }: Props) {
  const revealed = progress * DEPTH;
  const rowH = Math.max(2, Math.floor(height / DEPTH) - 6);
  return (
    <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}>
      {LEVELS.map((intervals, depth) => {
        // Fully revealed rows are solid; the row in progress fades in.
        const opacity = Math.max(0, Math.min(1, revealed - depth));
        return (
          <View key={depth} style={[styles.row, { height: rowH, opacity: 0.15 + 0.85 * opacity }]}>
            {intervals.map(([a, b], i) => (
              <View
                key={i}
                style={{
                  position: 'absolute',
                  left: `${a * 100}%`,
                  width: `${(b - a) * 100}%`,
                  top: 0,
                  bottom: 0,
                  backgroundColor: opacity > 0 ? barColor : color.line,
                  borderRadius: 1,
                }}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 6 },
});

export const CantorSet = memo(CantorSetInner);
