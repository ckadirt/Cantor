/**
 * The panel sigil — a small Skia canvas whose strokes morph from the previous
 * panel's mark into the current one on the shared transition clock. Same
 * pipeline as the intro: centerline → ribbon (Path.stroke) → resample →
 * interpolatePaths on the UI thread. When the two sigils differ in stroke
 * count, the extra morphs share a source/target, so ribbons visibly split or
 * merge — the manim gesture again.
 */
import React, { useEffect, useMemo } from 'react';
import {
  Canvas,
  interpolatePaths,
  Path,
  Skia,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  align,
  placeSymbol,
  polygonPath,
  resampleStrokedSvg,
  smoothstep,
} from './morph';
import { SIGIL_STROKE, type Sigil } from './sigils';

const SIGIL_SCALE = 0.82; // mark size as a fraction of the zone's short side
const STAGGER = 0.08; // per-stroke start offset on the 0..1 clock
const SIGIL_OPACITY = 1; // full ink — the sigil is the panel's illustration

type StrokeModel = {
  home: SkPath;
  target: SkPath;
  out: SkPath;
  winA: number;
  winB: number;
  // Extra strokes (beyond the smaller sigil's count) share a partner path;
  // they fade instead of piling onto it, so merges/splits stay thin.
  fadesOut: boolean;
  fadesIn: boolean;
};

function MorphStroke({
  m,
  t,
  color,
}: {
  m: StrokeModel;
  t: SharedValue<number>;
  color: string;
}) {
  const path = useDerivedValue(() =>
    interpolatePaths(
      smoothstep(m.winA, m.winB, t.value),
      [0, 1],
      [m.home, m.target],
      undefined,
      m.out,
    ),
  );
  const opacity = useDerivedValue(() => {
    if (m.fadesOut) {
      return SIGIL_OPACITY * (1 - smoothstep(0.15, 0.6, t.value));
    }
    if (m.fadesIn) {
      return SIGIL_OPACITY * smoothstep(0.4, 0.85, t.value);
    }
    return SIGIL_OPACITY;
  });
  return <Path path={path} color={color} opacity={opacity} />;
}

/**
 * Owns its clock and starts at 0 on mount, so the first painted frame is
 * exactly the previous panel's mark — remount it (via `key`) per transition
 * and the hand-off is seamless, with no race against the React commit.
 */
export function SigilMark({
  from,
  to,
  duration,
  width,
  height,
  color,
}: {
  from: Sigil;
  to: Sigil;
  duration: number;
  width: number;
  height: number;
  color: string;
}) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withTiming(1, { duration, easing: Easing.linear });
  }, [t, duration]);

  const strokes = useMemo<StrokeModel[]>(() => {
    const cx = width / 2;
    const cy = height / 2;
    const size = Math.min(width, height) * SIGIL_SCALE;
    const k = Math.max(from.strokes.length, to.strokes.length);
    const span = 1 - STAGGER * (k - 1); // each stroke's window length
    const models: StrokeModel[] = [];
    for (let i = 0; i < k; i++) {
      const src = from.strokes[Math.min(i, from.strokes.length - 1)];
      const dst = to.strokes[Math.min(i, to.strokes.length - 1)];
      const a = placeSymbol(resampleStrokedSvg(src, SIGIL_STROKE), cx, cy, size, 0);
      const b = align(
        a,
        placeSymbol(resampleStrokedSvg(dst, SIGIL_STROKE), cx, cy, size, 0),
      );
      models.push({
        home: polygonPath(a),
        target: polygonPath(b),
        out: Skia.Path.Make(),
        winA: STAGGER * i,
        winB: STAGGER * i + span,
        fadesOut: i >= to.strokes.length,
        fadesIn: i >= from.strokes.length,
      });
    }
    return models;
  }, [from, to, width, height]);

  return (
    <Canvas style={{ width, height }}>
      {strokes.map((m, i) => (
        <MorphStroke key={i} m={m} t={t} color={color} />
      ))}
    </Canvas>
  );
}
