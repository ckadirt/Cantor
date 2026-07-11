/**
 * Onboarding — panel 1. The Cantor set draws itself in from the centre bar
 * (middle-thirds, staggered outward like a 3Blue1Brown Create), then every bar
 * disperses to the borders, morphing into a quiet field of math and music marks
 * — leaving the name and the promise alone in the middle.
 *
 * All motion eases like a function: pure smoothstep windows over one linear
 * clock, nothing bouncy. Morphing is the manim trick (resample → interpolate)
 * running on the UI thread via Skia's interpolatePaths. See morph.ts.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  Canvas,
  Group,
  interpolatePaths,
  Path,
  Skia,
  type SkPath,
} from '@shopify/react-native-skia';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { barSvg, layoutBars } from './cantorBars';
import {
  align,
  mulberry32,
  placeSymbol,
  polygonPath,
  resample,
  resampleStrokedSvg,
} from './morph';
import { STROKE, SYMBOLS } from './symbols';
import { space, type, usePalette } from '../theme/tokens';

/** The slogan under the wordmark. One line; keep it short. */
const SLOGAN = 'The beautiful way to interact with music.';

// Timeline, in seconds (normalised against DURATION below). Tune freely.
const BUILD_BASE = 0.15; // first bar draws in
const BUILD_ROW_STEP = 0.1; // per row, centre outward
const BUILD_DUR = 0.5;
const MORPH_BASE = 1.15; // first bar starts morphing
const MORPH_STEP = 0.1; // even one-by-one cascade, ~0.1s apart
const MORPH_DUR = 0.55;
const DURATION = 5200; // ms, whole intro

// ── worklet easing helpers ──────────────────────────────────────────────────
function smoothstep(a: number, b: number, x: number): number {
  'worklet';
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

type BarModel = {
  homePath: SkPath;
  targetPath: SkPath;
  out: SkPath;
  cx: number;
  cy: number;
  buildStart: number;
  buildEnd: number;
  morphStart: number;
  morphEnd: number;
};

function Bar({ m, p, color }: { m: BarModel; p: SharedValue<number>; color: string }) {
  const reveal = useDerivedValue(() => smoothstep(m.buildStart, m.buildEnd, p.value));
  const morphT = useDerivedValue(() => smoothstep(m.morphStart, m.morphEnd, p.value));

  const path = useDerivedValue(() =>
    interpolatePaths(morphT.value, [0, 1], [m.homePath, m.targetPath], undefined, m.out),
  );

  // grow from the bar's centre (the middle-thirds gesture), then settle to a
  // faint constellation once the name takes over.
  const transform = useDerivedValue(() => [{ scaleX: reveal.value }]);
  const opacity = useDerivedValue(() => {
    const frame = 1 - 0.6 * smoothstep(0.66, 0.92, p.value);
    return reveal.value * frame;
  });

  return (
    <Group transform={transform} origin={{ x: m.cx, y: m.cy }}>
      <Path path={path} color={color} opacity={opacity} />
    </Group>
  );
}

export function IntroPanel({ onNext }: { onNext: () => void }) {
  const pal = usePalette();
  const { width, height } = useWindowDimensions();
  const p = useSharedValue(0);
  const [ready, setReady] = useState(false);

  const bars = useMemo<BarModel[]>(() => {
    const cx = width / 2;
    const cy = height * 0.42; // sit the mark a little above centre
    const size = Math.min(width, height) * 0.52;
    const margin = 28;
    const sec = 1000 / DURATION; // seconds → normalised clock

    const laid = layoutBars(size, cx, cy);
    // Morph cascade order: a clean left-to-right sweep, evenly spaced in time —
    // not the centre-first bloom the radial ordering gave.
    const order = laid.map((_, i) => i).sort((a, b) => laid[a].cx - laid[b].cx);
    const morphIndex = new Array<number>(laid.length);
    order.forEach((barI, rank) => (morphIndex[barI] = rank));

    return laid.map((bar, i) => {
      const rand = mulberry32(i * 2654435761);
      const sym = SYMBOLS[i % SYMBOLS.length];

      // scatter toward the borders along the bar's own outward direction
      let angle = Math.atan2(bar.cy - cy, bar.cx - cx);
      if (!Number.isFinite(angle) || (bar.cx === cx && bar.cy === cy)) {
        angle = rand() * Math.PI * 2;
      }
      const radX = (0.5 + rand() * 0.42) * (width / 2);
      const radY = (0.42 + rand() * 0.5) * (height / 2);
      const tx = Math.min(width - margin, Math.max(margin, cx + Math.cos(angle) * radX));
      const ty = Math.min(height - margin, Math.max(margin, cy + Math.sin(angle) * radY));
      const symSize = 30 + rand() * 20; // thin glyphs read better a touch larger
      const spin = (rand() - 0.5) * 0.7; // gentle tilt only — keep glyphs legible

      const homePts = resample(Skia.Path.MakeFromSVGString(barSvg(bar.rect))!);
      const symPts = resampleStrokedSvg(sym.svg, STROKE);
      const targetPts =
        symPts.length > 0
          ? align(homePts, placeSymbol(symPts, tx, ty, symSize, spin))
          : homePts; // fallback: bar just fades in place if the glyph didn't parse

      const buildStart = BUILD_BASE + bar.rowRank * BUILD_ROW_STEP;
      const morphStart = MORPH_BASE + morphIndex[i] * MORPH_STEP;
      return {
        homePath: polygonPath(homePts),
        targetPath: polygonPath(targetPts),
        out: Skia.Path.Make(),
        cx: bar.cx,
        cy: bar.cy,
        buildStart: buildStart * sec,
        buildEnd: (buildStart + BUILD_DUR) * sec,
        morphStart: morphStart * sec,
        morphEnd: (morphStart + MORPH_DUR) * sec,
      };
    });
  }, [width, height]);

  useEffect(() => {
    p.value = withTiming(1, { duration: DURATION, easing: Easing.linear });
    const t = setTimeout(() => setReady(true), DURATION + 150);
    return () => clearTimeout(t);
  }, [p]);

  const nameStyle = useAnimatedStyle(() => {
    const a = smoothstep(0.82, 0.99, p.value);
    return {
      opacity: a,
      transform: [{ translateY: (1 - a) * 12 }, { scale: 0.97 + 0.03 * a }],
    };
  });

  // Tap anywhere to fast-forward the reveal; once it's done, tap advances.
  const skip = () => {
    if (ready) {
      onNext();
    } else {
      p.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) });
      setTimeout(() => setReady(true), 460);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={skip}>
        <Canvas style={StyleSheet.absoluteFill}>
          {bars.map((m, i) => (
            <Bar key={i} m={m} p={p} color={pal.ink} />
          ))}
        </Canvas>
      </Pressable>

      <Animated.View style={[styles.center, nameStyle]} pointerEvents="none">
        <Text style={[styles.wordmark, { color: pal.ink }]}>Cantor</Text>
        <Text style={[styles.slogan, { color: pal.muted }]}>{SLOGAN}</Text>
      </Animated.View>

      {ready && (
        <Animated.View
          entering={FadeIn.duration(360)}
          style={styles.footer}
          pointerEvents="box-none">
          <Pressable style={[styles.button, { borderColor: pal.ink }]} onPress={onNext}>
            <Text style={[styles.buttonLabel, { color: pal.ink }]}>Begin</Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  center: {
    position: 'absolute',
    top: '42%',
    left: 0,
    right: 0,
    alignItems: 'center',
    marginTop: -24,
  },
  wordmark: {
    ...type.wordmark,
    fontSize: 52,
  },
  slogan: {
    ...type.small,
    marginTop: space.sm,
    textAlign: 'center',
    paddingHorizontal: space.xl,
    letterSpacing: 0.3,
  },
  footer: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.xl,
  },
  button: {
    borderWidth: 1,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  buttonLabel: {
    ...type.mono,
  },
});
