/**
 * TransformMatchingShapes for text, on the intro's substrate: glyphs drawn on
 * one Skia canvas instead of a per-character forest of RN Text views. Layout
 * comes synchronously from font metrics (no onLayout roundtrip, no ghost
 * frames), a transition is three draw calls (exits / movers / enters), and the
 * only React commit per change is swapping the flight model in.
 *
 * Same motion grammar as everything else: one linear clock, smootherstep
 * windows, flights on gentle arcs, cascaded in reading order. Retargets
 * mid-flight capture the live positions and flow on from there.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import {
  Canvas,
  Glyphs,
  Group,
  interpolatePaths,
  Path,
  Skia,
  type SkFont,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { bornClock } from './clock';
import { smootherstep } from './geometry';
import { useMorphFont } from './fonts';
import { buildGlyphMorphPaths } from './glyphs';
import {
  buildFlights,
  ENTER_RISE,
  ENTER_START,
  EXIT_END,
  EXIT_RISE,
  layoutText,
  MOVE_END,
  MOVE_START,
  MOVER_DIP,
  type CharBox,
  type Flights,
  type MorphPair,
} from './text';

type Glyph = { id: number; pos: { x: number; y: number } };

/** A shape-morphing pair, its outline paths prebuilt (native Skia only). */
type MorphModel = MorphPair & {
  fromPath: SkPath;
  toPath: SkPath;
  out: SkPath;
  /** The destination character as real glyphs — shown once the morph lands. */
  toGlyphs: Glyph[];
};

function toGlyphs(boxes: CharBox[], rise = 0): Glyph[] {
  const out: Glyph[] = [];
  for (const b of boxes) {
    for (let i = 0; i < b.ids.length; i++) {
      out.push({ id: b.ids[i], pos: { x: b.x + b.xo[i], y: b.y + rise } });
    }
  }
  return out;
}

/** Live glyph positions at clock value t — the JS mirror of the worklet math. */
function captureBoxes(f: Flights, t: number): CharBox[] {
  const boxes: CharBox[] = [];
  for (const m of f.movers) {
    const u = smootherstep(m.a, m.b, t);
    const arc = 4 * u * (1 - u);
    boxes.push({
      ...m.box,
      x: m.fx + (m.tx - m.fx) * u + m.px * arc,
      y: m.fy + (m.ty - m.fy) * u + m.py * arc,
    });
  }
  for (const m of f.morphs) {
    // A half-morphed outline isn't a glyph; approximate with whichever
    // character it currently resembles more, at the interpolated position.
    const u = smootherstep(m.a, m.b, t);
    const arc = 4 * u * (1 - u);
    const near = u < 0.5 ? m.from : m.to;
    boxes.push({
      ...near,
      x: m.from.x + (m.to.x - m.from.x) * u + m.px * arc,
      y: m.from.y + (m.to.y - m.from.y) * u + m.py * arc,
    });
  }
  const exitA = 1 - smootherstep(0, EXIT_END, t);
  if (exitA > 0.25) {
    const rise = EXIT_RISE * smootherstep(0, EXIT_END, t);
    for (const b of f.exits) {
      boxes.push({ ...b, y: b.y - rise });
    }
  }
  const enterA = smootherstep(ENTER_START, 1, t);
  if (enterA > 0.25) {
    for (const b of f.enters) {
      boxes.push({ ...b, y: b.y + ENTER_RISE * (1 - enterA) });
    }
  }
  return boxes;
}

type Model = {
  text: string;
  width: number;
  font: SkFont;
  flights: Flights;
  morphModels: MorphModel[];
  exitGlyphs: Glyph[];
  enterGlyphs: Glyph[];
  /** Born at 0 when animating, 1 when settled — never reset across models. */
  clock: SharedValue<number>;
  animate: boolean;
  gen: number;
};

/**
 * Prebuild outline paths for the shape-morphing pairs. Where the platform
 * can't outline a glyph, the pair quietly degrades to exit + enter.
 */
function buildMorphModels(font: SkFont, flights: Flights): MorphModel[] {
  const models: MorphModel[] = [];
  const failed: MorphPair[] = [];
  for (const m of flights.morphs) {
    const paths = buildGlyphMorphPaths(font, m.from, m.to);
    if (paths) {
      models.push({
        ...m,
        fromPath: paths.from,
        toPath: paths.to,
        out: Skia.Path.Make(),
        toGlyphs: toGlyphs([m.to]),
      });
    } else {
      failed.push(m);
    }
  }
  if (failed.length > 0) {
    flights.morphs = flights.morphs.filter(m => !failed.includes(m));
    flights.exits = [...flights.exits, ...failed.map(m => m.from)];
    flights.enters = [...flights.enters, ...failed.map(m => m.to)];
  }
  return models;
}

function MorphGlyph({
  m,
  tt,
  font,
  color,
  dip,
}: {
  m: MorphModel;
  tt: SharedValue<number>;
  font: SkFont;
  color: string;
  dip: SharedValue<number>;
}) {
  const path = useDerivedValue(() =>
    interpolatePaths(
      smootherstep(m.a, m.b, tt.value),
      [0, 1],
      [m.fromPath, m.toPath],
      undefined,
      m.out,
    ),
  );
  // travel lives in the paths; only the arc bulge rides a transform
  const shift = useDerivedValue(() => {
    const u = smootherstep(m.a, m.b, tt.value);
    const arc = 4 * u * (1 - u);
    return [{ translateX: m.px * arc }, { translateY: m.py * arc }];
  });
  // The moment the morph lands, the approximated outline hands off to the
  // real glyph — same mounted nodes, pure UI-thread ramps. (No React commit
  // may ever happen at animation end: a commit racing a ticking mapper can
  // scramble the old recording's variables and paint a partial frame.)
  const pathAlpha = useDerivedValue(() =>
    smootherstep(m.a, m.b, tt.value) >= 1 ? 0 : dip.value,
  );
  const glyphAlpha = useDerivedValue(() =>
    smootherstep(m.a, m.b, tt.value) >= 1 ? 1 : 0,
  );
  return (
    <Group transform={shift}>
      <Path path={path} style="fill" fillType="evenOdd" color={color} opacity={pathAlpha} />
      <Glyphs font={font} glyphs={m.toGlyphs} color={color} opacity={glyphAlpha} />
    </Group>
  );
}

type Props = {
  text: string;
  charStyle: TextStyle;
  color: string;
  duration?: number;
  /** Outer container — reserve a fixed height here so the page never shifts. */
  style?: StyleProp<ViewStyle>;
  /** External clock (0..1) — the component stops driving its own. */
  progress?: SharedValue<number>;
};

/**
 * Memoized so unrelated parent commits (e.g. the onboarding body swapping
 * mid-transition) can't re-render the canvas: a Skia re-record while its
 * mapper is ticking is exactly the partial-frame race.
 */
export const MorphText = React.memo(MorphTextImpl);

function MorphTextImpl({ text, charStyle, color, duration = 700, style, progress }: Props) {
  const idle = useSharedValue(1); // stand-in clock until the first model exists
  const reduced = useReducedMotion();
  const font = useMorphFont(charStyle);
  const [width, setWidth] = useState(0);
  const [model, setModel] = useState<Model | null>(null);
  const genRef = useRef(0);

  if (font && width > 0 && (model?.text !== text || model.width !== width || model.font !== font)) {
    const lineHeight = charStyle.lineHeight ?? (charStyle.fontSize ?? 14) * 1.35;
    const next = layoutText(text, font, charStyle.letterSpacing ?? 0, width, lineHeight);
    // Same canvas and font → animate from the live glyph positions. A fresh
    // mount (or width/font change) just sits at the new layout.
    const retarget = model !== null && model.width === width && model.font === font;
    const captureT = progress ? progress.value : model?.clock.value ?? 1;
    let flights: Flights;
    if (!retarget) {
      flights = { movers: [], morphs: [], exits: [], enters: next };
    } else if (reduced) {
      flights = {
        movers: [],
        morphs: [],
        exits: captureBoxes(model.flights, captureT),
        enters: next,
      };
    } else {
      flights = buildFlights(captureBoxes(model.flights, captureT), next, width);
    }
    const morphModels = buildMorphModels(font, flights);
    genRef.current++;
    // Each model owns a clock born at its start value — the committed tree can
    // never paint against a stale clock from the previous transition.
    setModel({
      text,
      width,
      font,
      flights,
      morphModels,
      exitGlyphs: toGlyphs(flights.exits),
      enterGlyphs: toGlyphs(flights.enters),
      clock: bornClock(retarget && !progress ? 0 : 1),
      animate: retarget,
      gen: genRef.current,
    });
  }

  const tt = progress ?? model?.clock ?? idle;

  // No completion callback, no settle commit: React must never touch the
  // tree at animation end (see MorphGlyph). The next transition's build
  // captures homes off the parked flights just the same.
  useEffect(() => {
    if (!model?.animate || progress) {
      return;
    }
    const clock = model.clock;
    clock.value = withTiming(1, { duration, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [model, progress, duration]);

  const movers = model?.flights.movers ?? [];
  const moverGlyphs = useDerivedValue(() => {
    const out: Glyph[] = [];
    for (const m of movers) {
      const u = smootherstep(m.a, m.b, tt.value);
      const arc = 4 * u * (1 - u);
      const x = m.fx + (m.tx - m.fx) * u + m.px * arc;
      const y = m.fy + (m.ty - m.fy) * u + m.py * arc;
      for (let i = 0; i < m.ids.length; i++) {
        out.push({ id: m.ids[i], pos: { x: x + m.xo[i], y } });
      }
    }
    return out;
  }, [movers, tt]);
  const moverAlpha = useDerivedValue(() => {
    const p = smootherstep(MOVE_START, MOVE_END, tt.value);
    return 1 - MOVER_DIP * 4 * p * (1 - p);
  });
  const exitAlpha = useDerivedValue(() => 1 - smootherstep(0, EXIT_END, tt.value));
  const exitShift = useDerivedValue(() => [
    { translateY: -EXIT_RISE * smootherstep(0, EXIT_END, tt.value) },
  ]);
  const enterAlpha = useDerivedValue(() => smootherstep(ENTER_START, 1, tt.value));
  const enterShift = useDerivedValue(() => [
    { translateY: ENTER_RISE * (1 - smootherstep(ENTER_START, 1, tt.value)) },
  ]);

  return (
    <View
      style={style}
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}>
      {model && font && (
        <Canvas style={StyleSheet.absoluteFill}>
          {/* Every layer remounts per generation (keys): Skia applies node
              insert/remove batches atomically with the commit, but prop
              updates on LIVE nodes land a frame late — updating a persistent
              node's glyphs array mid-choreography is how one-frame flickers
              happen (verified frame-by-frame; the always-remounting sigils
              never flicker). */}
          <Glyphs
            key={`ex${model.gen}`}
            font={font}
            glyphs={model.exitGlyphs}
            transform={exitShift}
            color={color}
            opacity={exitAlpha}
          />
          {model.morphModels.map((m, i) => (
            <MorphGlyph
              key={`${model.gen}#${i}`}
              m={m}
              tt={tt}
              font={font}
              color={color}
              dip={moverAlpha}
            />
          ))}
          <Glyphs
            key={`mv${model.gen}`}
            font={font}
            glyphs={moverGlyphs}
            color={color}
            opacity={moverAlpha}
          />
          <Glyphs
            key={`en${model.gen}`}
            font={font}
            glyphs={model.enterGlyphs}
            transform={enterShift}
            color={color}
            opacity={enterAlpha}
          />
        </Canvas>
      )}
    </View>
  );
}
