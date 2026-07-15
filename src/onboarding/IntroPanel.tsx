/**
 * Onboarding — panel 1. The Cantor set draws itself in from the centre bar
 * (middle-thirds, staggered outward like a 3Blue1Brown Create), then every bar
 * resolves into a constellation of canonical mathematical and musical symbols
 * around a quiet centre reserved for the name and promise.
 *
 * All motion eases like a function: pure smootherstep windows over one linear
 * clock, nothing bouncy. Morphing is the manim trick (resample → interpolate)
 * running on the UI thread via Skia's interpolatePaths. See src/motion.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
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
  alignClosed,
  centroid,
  compoundPolygonPath,
  resolveSilhouette,
  sampleOutline,
  SILHOUETTE_N,
  smootherstep,
} from '../motion';
import {
  CONSTELLATION_SYMBOLS,
  INTRO_CONTOUR_COUNT,
  type ConstellationSymbol,
} from './symbols';
import { space, type, usePalette } from '../theme/tokens';

/** The slogan under the wordmark. One line; keep it short. */
const SLOGAN = 'The beautiful way to interact with music.';

// Timeline, all in real seconds — the whole intro is scheduled off these, so
// changing one phase never quietly speeds up another. Tune freely.
const BUILD_BASE = 0.15; // first bar draws in — the Cantor set, kept as it was
const BUILD_ROW_STEP = 0.1; // per row, centre outward
const BUILD_DUR = 0.5;
const MORPH_BASE = 1.1; // first bar starts morphing
const MORPH_TOTAL = 1.5; // the whole cascade of morphs spans exactly this
const MORPH_DUR = 0.5; // each bar's own morph
const REVEAL_START = 2.62; // copy starts only after the final morph clears centre
const REVEAL_DUR = 0.65;
const FRAME_START = 2.0; // symbols settle to a faint constellation
const FRAME_DUR = 1.0;
const DURATION_S = 3.3; // whole intro, seconds
const DURATION = DURATION_S * 1000; // ms

// Geometry knobs — positions are fractions of the live viewport. The middle
// fractions are a hard copy exclusion zone: no target contour lands there.
const MARK_CENTER_Y = 0.42;
const MARK_SIZE = 0.52;
const COPY_CLEAR_TOP = 0.3;
const COPY_CLEAR_BOTTOM = 0.56;
const COPY_CLEAR_GAP = 16; // px between final ink and the reserved copy zone
const FOOTER_CLEARANCE = 132; // px kept clear for Begin and its breathing room

type ConstellationPlacement = {
  item: ConstellationSymbol;
  x: number;
  y: number;
  size: number;
  spin: number;
  opacity: number;
};

const byKey = Object.fromEntries(
  CONSTELLATION_SYMBOLS.map(item => [item.key, item]),
) as Record<ConstellationSymbol['key'], ConstellationSymbol>;

const CONSTELLATION_PLACEMENTS: readonly ConstellationPlacement[] = [
  {
    item: byKey.alephNull,
    x: 0.1,
    y: 0.16,
    size: 0.17,
    spin: 0,
    opacity: 0.5,
  },
  {
    item: byKey.infinity,
    x: 0.29,
    y: 0.19,
    size: 0.12,
    spin: 0,
    opacity: 0.43,
  },
  {
    item: byKey.cantorSet,
    x: 0.49,
    y: 0.14,
    size: 0.18,
    spin: 0,
    opacity: 0.47,
  },
  {
    item: byKey.contourIntegral,
    x: 0.69,
    y: 0.19,
    size: 0.17,
    spin: 0,
    opacity: 0.44,
  },
  {
    item: byKey.trebleClef,
    x: 0.9,
    y: 0.15,
    size: 0.2,
    spin: 0,
    opacity: 0.5,
  },
  {
    item: byKey.segno,
    x: 0.1,
    y: 0.68,
    size: 0.18,
    spin: 0,
    opacity: 0.47,
  },
  {
    item: byKey.fermata,
    x: 0.3,
    y: 0.72,
    size: 0.13,
    spin: 0,
    opacity: 0.42,
  },
  {
    item: byKey.partial,
    x: 0.5,
    y: 0.67,
    size: 0.18,
    spin: 0,
    opacity: 0.47,
  },
  { item: byKey.nabla, x: 0.7, y: 0.72, size: 0.15, spin: 0, opacity: 0.42 },
  {
    item: byKey.continuum,
    x: 0.9,
    y: 0.68,
    size: 0.18,
    spin: 0,
    opacity: 0.47,
  },
];

// The same windows on the 0..1 master clock, for the worklet-side reveal/fade.
const REVEAL_A = REVEAL_START / DURATION_S;
const REVEAL_B = (REVEAL_START + REVEAL_DUR) / DURATION_S;
const FRAME_A = FRAME_START / DURATION_S;
const FRAME_B = (FRAME_START + FRAME_DUR) / DURATION_S;
const MORPH_SWITCH = MORPH_BASE / DURATION_S;

type BarModel = {
  homePath: SkPath;
  cx: number;
  cy: number;
  buildStart: number;
  buildEnd: number;
};

type GlyphMorphModel = {
  fromPath: SkPath;
  toPath: SkPath;
  out: SkPath;
  morphStart: number;
  morphEnd: number;
  settledOpacity: number;
};

type TargetModel = {
  symbolIndex: number;
  pts: ReturnType<typeof sampleOutline>;
  cx: number;
  cy: number;
};

function placedSymbolY(
  placement: ConstellationPlacement,
  height: number,
  symbolSize: number,
): number {
  const desiredY = height * placement.y;
  const isUpper = placement.y < COPY_CLEAR_TOP;
  const symbolExtent = symbolSize * 0.5;
  return isUpper
    ? Math.min(
      desiredY,
      height * COPY_CLEAR_TOP - symbolExtent - COPY_CLEAR_GAP,
    )
    : Math.min(
      height - FOOTER_CLEARANCE - symbolExtent,
      Math.max(
        desiredY,
        height * COPY_CLEAR_BOTTOM + symbolExtent + COPY_CLEAR_GAP,
      ),
    );
}

function Bar({
  m,
  p,
  color,
}: {
  m: BarModel;
  p: SharedValue<number>;
  color: string;
}) {
  const reveal = useDerivedValue(() =>
    smootherstep(m.buildStart, m.buildEnd, p.value),
  );

  // Build as independent Cantor bars. At MORPH_SWITCH an identical compound
  // source path takes over, so the change of renderer is visually lossless.
  const transform = useDerivedValue(() => [{ scaleX: reveal.value }]);
  const opacity = useDerivedValue(() =>
    p.value < MORPH_SWITCH ? reveal.value : 0,
  );

  return (
    <Group transform={transform} origin={{ x: m.cx, y: m.cy }}>
      <Path path={m.homePath} color={color} opacity={opacity} />
    </Group>
  );
}

function GlyphMorph({
  model,
  p,
  color,
}: {
  model: GlyphMorphModel;
  p: SharedValue<number>;
  color: string;
}) {
  const morphT = useDerivedValue(() =>
    smootherstep(model.morphStart, model.morphEnd, p.value),
  );
  const path = useDerivedValue(() =>
    interpolatePaths(
      morphT.value,
      [0, 1],
      [model.fromPath, model.toPath],
      undefined,
      model.out,
    ),
  );
  const opacity = useDerivedValue(() => {
    if (p.value < MORPH_SWITCH) {
      return 0;
    }
    return (
      1 - (1 - model.settledOpacity) * smootherstep(FRAME_A, FRAME_B, p.value)
    );
  });
  return (
    <Path
      path={path}
      style="fill"
      fillType="evenOdd"
      color={color}
      opacity={opacity}
    />
  );
}

export function IntroPanel({ onNext }: { onNext: () => void }) {
  const pal = usePalette();
  const { width, height } = useWindowDimensions();
  const p = useSharedValue(0);
  const [ready, setReady] = useState(false);

  const scene = useMemo<{
    bars: BarModel[];
    glyphs: GlyphMorphModel[];
  }>(() => {
    const cx = width / 2;
    const cy = height * MARK_CENTER_Y; // sit the mark a little above centre
    const shortSide = Math.min(width, height);
    const size = shortSide * MARK_SIZE;
    const sec = 1000 / DURATION; // seconds → normalised clock

    const laid = layoutBars(size, cx, cy);
    if (laid.length !== INTRO_CONTOUR_COUNT) {
      throw new Error(
        `intro: ${laid.length} Cantor bars cannot map to ${INTRO_CONTOUR_COUNT} contours`,
      );
    }
    const homeContours = laid.map(bar =>
      sampleOutline(
        Skia.Path.MakeFromSVGString(barSvg(bar.rect))!,
        SILHOUETTE_N,
      ),
    );
    const bars = laid.map((bar, index) => {
      const buildStart = BUILD_BASE + bar.rowRank * BUILD_ROW_STEP;
      return {
        homePath: compoundPolygonPath([homeContours[index]]),
        cx: bar.cx,
        cy: bar.cy,
        buildStart: buildStart * sec,
        buildEnd: (buildStart + BUILD_DUR) * sec,
      };
    });

    // Resolve the actual STIX/Noto compound outlines—not the animation
    // centerlines—at their final constellation positions.
    const targetsBySymbol = CONSTELLATION_PLACEMENTS.map(
      (placement, symbolIndex) => {
        const { symbol } = placement.item;
        const symbolSize = shortSide * placement.size;
        const symbolY = placedSymbolY(placement, height, symbolSize);
        const ratio = symbol.aspectRatio ?? 1;
        const silhouette = resolveSilhouette(
          symbol,
          symbolSize * ratio,
          symbolSize,
          1,
          {
            centerX: width * placement.x,
            centerY: symbolY,
            strokeWidth: symbol.strokeWidth,
          },
          SILHOUETTE_N,
        );
        return silhouette.contours.map(pts => {
          const center = centroid(pts);
          return {
            symbolIndex,
            pts,
            cx: center.x,
            cy: center.y,
          } satisfies TargetModel;
        });
      },
    );

    const exactCount = targetsBySymbol.reduce(
      (sum, targets) => sum + targets.length,
      0,
    );
    if (exactCount > laid.length) {
      throw new Error(
        `intro: ${laid.length} Cantor bars cannot cover ${exactCount} exact glyph contours`,
      );
    }
    // Font glyphs currently need 25 rings. The remaining four bars do not
    // fade: each becomes a degenerate zero-area ring inside one symbol.
    const paddingOrder = [0, 9, 2, 5, 4, 7, 1, 8, 3, 6];
    for (let i = 0; i < laid.length - exactCount; i++) {
      const symbolIndex = paddingOrder[i % paddingOrder.length];
      const placement = CONSTELLATION_PLACEMENTS[symbolIndex];
      const symbolSize = shortSide * placement.size;
      const point = {
        x: width * placement.x,
        y: placedSymbolY(placement, height, symbolSize),
      };
      targetsBySymbol[symbolIndex].push({
        symbolIndex,
        pts: Array.from({ length: SILHOUETTE_N }, () => ({ ...point })),
        cx: point.x,
        cy: point.y,
      });
    }

    const targets = targetsBySymbol.flat();

    // Preserve spatial order on both sides so paths fan outward instead of
    // tangling through one another on their way to the constellation.
    const barOrder = laid
      .map((_, i) => i)
      .sort((a, b) => laid[a].cy - laid[b].cy || laid[a].cx - laid[b].cx);
    const targetOrder = targets
      .map((_, i) => i)
      .sort(
        (a, b) =>
          targets[a].cy - targets[b].cy || targets[a].cx - targets[b].cx,
      );
    const pairsBySymbol: {
      from: TargetModel['pts'];
      to: TargetModel['pts'];
    }[][] = CONSTELLATION_PLACEMENTS.map(() => []);
    barOrder.forEach((barIndex, rank) => {
      const target = targets[targetOrder[rank]];
      const source = homeContours[barIndex];
      pairsBySymbol[target.symbolIndex].push({
        from: source,
        to: alignClosed(source, target.pts),
      });
    });

    const morphStep =
      (MORPH_TOTAL - MORPH_DUR) /
      Math.max(1, CONSTELLATION_PLACEMENTS.length - 1);
    const glyphs = pairsBySymbol.map((pairs, symbolIndex) => {
      const morphStart = MORPH_BASE + symbolIndex * morphStep;
      return {
        fromPath: compoundPolygonPath(pairs.map(pair => pair.from)),
        toPath: compoundPolygonPath(pairs.map(pair => pair.to)),
        out: Skia.Path.Make(),
        morphStart: morphStart * sec,
        morphEnd: (morphStart + MORPH_DUR) * sec,
        settledOpacity: CONSTELLATION_PLACEMENTS[symbolIndex].opacity,
      };
    });

    return { bars, glyphs };
  }, [width, height]);

  useEffect(() => {
    p.value = withTiming(1, { duration: DURATION, easing: Easing.linear });
    const t = setTimeout(() => setReady(true), DURATION + 150);
    return () => clearTimeout(t);
  }, [p]);

  const nameStyle = useAnimatedStyle(() => {
    const a = smootherstep(REVEAL_A, REVEAL_B, p.value);
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
      p.value = withTiming(1, {
        duration: 420,
        easing: Easing.out(Easing.cubic),
      });
      setTimeout(() => setReady(true), 460);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={skip}>
        <Canvas style={StyleSheet.absoluteFill}>
          {scene.bars.map((m, i) => (
            <Bar key={i} m={m} p={p} color={pal.ink} />
          ))}
          {scene.glyphs.map((model, index) => (
            <GlyphMorph
              key={CONSTELLATION_PLACEMENTS[index].item.key}
              model={model}
              p={p}
              color={pal.ink}
            />
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
          pointerEvents="box-none"
        >
          <Pressable
            style={[styles.button, { borderColor: pal.ink }]}
            onPress={onNext}
          >
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
