/**
 * Cantor's text-motion framework on one Skia canvas.
 *
 * Variants share synchronous font layout, glyph-outline geometry, one linear
 * clock, mid-flight capture, reduced-motion fallback, and UI-thread glyph
 * hand-offs:
 *
 *  - transform: plain Manim Transform — the whole text family changes on one
 *    shared alpha, in reading order, with no character matching or cascade;
 *  - matching: the existing TransformMatchingShapes gesture — words/letters
 *    find their counterparts and travel independently;
 *  - crossfade: simultaneous old/new exchange, also forced by reduced motion;
 *  - write appearance: Manim Write / DrawBorderThenFill — each exact glyph
 *    outline traces on, then resolves into its fill, with Manim's glyph lag.
 *
 * One Canvas avoids a forest of RN Text views. No completion callback mutates
 * the tree: animated outlines hand ownership to mounted Glyphs on the UI
 * thread, preserving the Flicker Law across React commits and Skia mapper ticks.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import {
  Canvas,
  Glyphs,
  Group,
  interpolatePaths,
  notifyChange,
  Path,
  Skia,
  type SkFont,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useAnimatedReaction,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { bornClock } from './clock';
import { smootherstep } from './geometry';
import { useMorphFont } from './fonts';
import { buildGlyphMorphPaths, placedGlyphPath } from './glyphs';
import {
  buildCrossfadeFlights,
  buildFlights,
  buildTransformFlights,
  DEFAULT_TEXT_TRANSFORM_MS,
  ENTER_RISE,
  ENTER_START,
  EXIT_END,
  EXIT_RISE,
  layoutText,
  MOVE_END,
  MOVE_START,
  MOVER_DIP,
  WRITE_STROKE_PX,
  writeDurationMs,
  writePhase,
  writeSubAlpha,
  type CharBox,
  type Flights,
  type MorphPair,
  type TextAppearance,
  type TextMotionVariant,
} from './text';

type Glyph = { id: number; pos: { x: number; y: number } };
type ModelKind = 'settled' | 'write' | TextMotionVariant;

/** A shape-morphing pair, its outline paths prebuilt once on the JS thread. */
type MorphModel = MorphPair & {
  fromPath: SkPath;
  toPath: SkPath;
  /** Destination as a real glyph — mounted before the UI-thread hand-off. */
  toGlyphs: Glyph[];
};

/**
 * A plain Transform is one coordinated text family, not N independent mapper
 * graphs. At most three layers are needed: visible→visible, hidden→visible,
 * and visible→hidden (Manim's unequal-family alignment copies).
 */
type TransformLayerModel = {
  fromPath: SkPath;
  toPath: SkPath;
  fromAlpha: number;
  toAlpha: number;
  toGlyphs: Glyph[];
};

type WriteModel = {
  path: SkPath;
  glyphs: Glyph[];
  index: number;
  count: number;
};

type Model = {
  text: string;
  width: number;
  font: SkFont;
  layout: CharBox[];
  kind: ModelKind;
  flights: Flights;
  morphModels: MorphModel[];
  transformLayers: TransformLayerModel[];
  writeModels: WriteModel[];
  writeFallback: CharBox[];
  exitGlyphs: Glyph[];
  enterGlyphs: Glyph[];
  /** Born at the start value; clocks are never reset across committed models. */
  clock: SharedValue<number>;
  animate: boolean;
  runTime: number;
  gen: number;
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

/** Live positions at t — the JS mirror used to seed interruption retargets. */
function captureBoxes(f: Flights, t: number, matching: boolean): CharBox[] {
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
    const u = smootherstep(m.a, m.b, t);
    const alpha = (m.fromAlpha ?? 1) + ((m.toAlpha ?? 1) - (m.fromAlpha ?? 1)) * u;
    if (alpha <= 0.02) {
      continue;
    }
    // A half-morphed outline is not a font glyph. As in the original engine,
    // retain whichever endpoint it resembles more at the live position.
    const arc = 4 * u * (1 - u);
    const near = u < 0.5 ? m.from : m.to;
    boxes.push({
      ...near,
      x: m.from.x + (m.to.x - m.from.x) * u + m.px * arc,
      y: m.from.y + (m.to.y - m.from.y) * u + m.py * arc,
    });
  }
  const exitA = matching
    ? 1 - smootherstep(0, EXIT_END, t)
    : 1 - smootherstep(0, 1, t);
  if (exitA > 0.25) {
    const rise = matching ? EXIT_RISE * smootherstep(0, EXIT_END, t) : 0;
    for (const b of f.exits) {
      boxes.push({ ...b, y: b.y - rise });
    }
  }
  const enterA = matching
    ? smootherstep(ENTER_START, 1, t)
    : smootherstep(0, 1, t);
  if (enterA > 0.25) {
    for (const b of f.enters) {
      boxes.push({ ...b, y: b.y + (matching ? ENTER_RISE * (1 - enterA) : 0) });
    }
  }
  return boxes;
}

function captureModel(model: Model, t: number): CharBox[] {
  if (model.kind === 'settled') {
    return model.layout;
  }
  if (model.kind !== 'write') {
    return captureBoxes(model.flights, t, model.kind === 'matching');
  }
  // Retargeting during Write starts from glyphs with a visible traced portion.
  return model.layout.filter((_, i) => {
    const phase = writePhase(writeSubAlpha(t, i, model.layout.length));
    return Math.max(phase.borderEnd * phase.borderAlpha, phase.fillAlpha) > 0.02;
  });
}

/** Prebuild outline interpolation; native failures degrade to crossfades. */
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
        toGlyphs: toGlyphs([m.to]),
      });
    } else {
      failed.push(m);
    }
  }
  if (failed.length > 0) {
    flights.morphs = flights.morphs.filter(m => !failed.includes(m));
    flights.exits = [
      ...flights.exits,
      ...failed.filter(m => (m.fromAlpha ?? 1) > 0.02).map(m => m.from),
    ];
    flights.enters = [
      ...flights.enters,
      ...failed.filter(m => (m.toAlpha ?? 1) > 0.02).map(m => m.to),
    ];
  }
  return models;
}

/**
 * Fuse all equally-visible glyph pairs into a single verb-identical path.
 * This is both closer to Manim's whole-Mobject Transform and substantially
 * cheaper than asking dozens of immutable SkPath host objects to invalidate
 * one Canvas independently on every display tick.
 */
function buildTransformLayers(models: MorphModel[]): TransformLayerModel[] {
  const groups = new Map<
    string,
    { fromAlpha: number; toAlpha: number; models: MorphModel[] }
  >();
  for (const model of models) {
    const fromAlpha = model.fromAlpha ?? 1;
    const toAlpha = model.toAlpha ?? 1;
    if (fromAlpha <= 0.02 && toAlpha <= 0.02) {
      continue;
    }
    const key = `${fromAlpha}:${toAlpha}`;
    const group = groups.get(key) ?? { fromAlpha, toAlpha, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }

  return [...groups.values()].map(group => {
    const from = Skia.PathBuilder.Make();
    const to = Skia.PathBuilder.Make();
    const destinationGlyphs: Glyph[] = [];
    for (const model of group.models) {
      from.addPath(model.fromPath);
      to.addPath(model.toPath);
      if (group.toAlpha > 0.02) {
        destinationGlyphs.push(...model.toGlyphs);
      }
    }
    return {
      fromPath: from.build(),
      toPath: to.build(),
      fromAlpha: group.fromAlpha,
      toAlpha: group.toAlpha,
      toGlyphs: destinationGlyphs,
    };
  });
}

function buildWriteModels(font: SkFont, boxes: CharBox[]) {
  const models: WriteModel[] = [];
  const fallback: CharBox[] = [];
  boxes.forEach((box, index) => {
    const path = placedGlyphPath(font, box);
    if (path) {
      models.push({ path, glyphs: toGlyphs([box]), index, count: boxes.length });
    } else {
      fallback.push(box);
    }
  });
  return { models, fallback };
}

/**
 * Skia's usePathInterpolation, but born already holding the path at the
 * clock's current value. The library hook is born holding an empty path that
 * its reaction only replaces one mapper tick after the commit — so a freshly
 * mounted generation paints nothing for a frame (the step-change flicker).
 * The reaction (with notifyChange) is kept as-is: it invalidates the canvas
 * on every tick, which a plain derived value of immutable paths does not.
 */
function useSeededPathInterpolation(
  amount: SharedValue<number> | DerivedValue<number>,
  fromPath: SkPath,
  toPath: SkPath,
) {
  const path = useSharedValue(
    interpolatePaths(amount.value, [0, 1], [fromPath, toPath]),
  );
  useAnimatedReaction(
    () => amount.value,
    value => {
      path.value = interpolatePaths(value, [0, 1], [fromPath, toPath]);
      notifyChange(path);
    },
    [fromPath, toPath],
  );
  return path;
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
  const amount = useDerivedValue(() => smootherstep(m.a, m.b, tt.value));
  const path = useSeededPathInterpolation(amount, m.fromPath, m.toPath);
  const shift = useDerivedValue(() => {
    const arc = 4 * amount.value * (1 - amount.value);
    return [{ translateX: m.px * arc }, { translateY: m.py * arc }];
  });
  const pathAlpha = useDerivedValue(() => {
    if (amount.value >= 1) {
      return 0;
    }
    const alpha = (m.fromAlpha ?? 1) + ((m.toAlpha ?? 1) - (m.fromAlpha ?? 1)) * amount.value;
    return alpha * dip.value;
  });
  const glyphAlpha = useDerivedValue(() =>
    amount.value >= 1 ? (m.toAlpha ?? 1) : 0,
  );
  return (
    <Group transform={shift}>
      <Path path={path} style="fill" fillType="evenOdd" color={color} opacity={pathAlpha} />
      <Glyphs font={font} glyphs={m.toGlyphs} color={color} opacity={glyphAlpha} />
    </Group>
  );
}

function TransformLayer({
  model,
  tt,
  font,
  color,
}: {
  model: TransformLayerModel;
  tt: SharedValue<number> | DerivedValue<number>;
  font: SkFont;
  color: string;
}) {
  const amount = useDerivedValue(() => smootherstep(0, 1, tt.value));
  const path = useSeededPathInterpolation(amount, model.fromPath, model.toPath);
  const pathAlpha = useDerivedValue(() => {
    const eased = smootherstep(0, 1, tt.value);
    if (eased >= 1) {
      return 0;
    }
    return model.fromAlpha + (model.toAlpha - model.fromAlpha) * eased;
  });
  const glyphAlpha = useDerivedValue(() =>
    smootherstep(0, 1, tt.value) >= 1 ? model.toAlpha : 0,
  );
  return (
    <>
      <Path path={path} style="fill" fillType="evenOdd" color={color} opacity={pathAlpha} />
      {model.toGlyphs.length > 0 && (
        <Glyphs font={font} glyphs={model.toGlyphs} color={color} opacity={glyphAlpha} />
      )}
    </>
  );
}

function WriteGlyph({
  model,
  tt,
  font,
  color,
}: {
  model: WriteModel;
  tt: SharedValue<number> | DerivedValue<number>;
  font: SkFont;
  color: string;
}) {
  const borderEnd = useDerivedValue(() =>
    writePhase(writeSubAlpha(tt.value, model.index, model.count)).borderEnd,
  );
  const borderAlpha = useDerivedValue(() =>
    writePhase(writeSubAlpha(tt.value, model.index, model.count)).borderAlpha,
  );
  const fillPathAlpha = useDerivedValue(() => {
    const phase = writePhase(writeSubAlpha(tt.value, model.index, model.count));
    return phase.settled ? 0 : phase.fillAlpha;
  });
  const glyphAlpha = useDerivedValue(() =>
    writePhase(writeSubAlpha(tt.value, model.index, model.count)).settled ? 1 : 0,
  );
  return (
    <>
      <Path
        path={model.path}
        style="stroke"
        start={0}
        end={borderEnd}
        strokeWidth={WRITE_STROKE_PX}
        strokeCap="round"
        strokeJoin="round"
        color={color}
        opacity={borderAlpha}
      />
      <Path
        path={model.path}
        style="fill"
        fillType="evenOdd"
        color={color}
        opacity={fillPathAlpha}
      />
      <Glyphs font={font} glyphs={model.glyphs} color={color} opacity={glyphAlpha} />
    </>
  );
}

function WriteFallbackGlyph({
  box,
  index,
  count,
  tt,
  font,
  color,
}: {
  box: CharBox;
  index: number;
  count: number;
  tt: SharedValue<number> | DerivedValue<number>;
  font: SkFont;
  color: string;
}) {
  const opacity = useDerivedValue(() =>
    smootherstep(0, 1, writeSubAlpha(tt.value, index, count)),
  );
  return <Glyphs font={font} glyphs={toGlyphs([box])} color={color} opacity={opacity} />;
}

/**
 * Everything a non-Write transition paints: exits, shape-morphs (or fused
 * transform layers), movers, and entrances. One instance per committed
 * generation, so every reanimated binding here is born on this model's clock
 * and dies with it. Were these derived values owned by MorphText itself, a
 * generation swap would re-register them against the newborn clock while the
 * outgoing nodes can still paint a frame — and a settled exit layer (opacity
 * 0 on the old clock) would light back up at full alpha (t=0 on the new one):
 * the "finished title flashes before it writes" race.
 */
function TransitionGlyphs({
  model,
  tt,
  font,
  color,
}: {
  model: Model;
  tt: SharedValue<number>;
  font: SkFont;
  color: string;
}) {
  const matching = model.kind === 'matching';
  const movers = model.flights.movers;
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
  const morphDip = useDerivedValue(() => {
    if (!matching) {
      return 1;
    }
    const p = smootherstep(MOVE_START, MOVE_END, tt.value);
    return 1 - MOVER_DIP * 4 * p * (1 - p);
  }, [matching, tt]);
  const exitAlpha = useDerivedValue(() =>
    matching
      ? 1 - smootherstep(0, EXIT_END, tt.value)
      : 1 - smootherstep(0, 1, tt.value),
  [matching, tt]);
  const exitShift = useDerivedValue(() => [
    { translateY: matching ? -EXIT_RISE * smootherstep(0, EXIT_END, tt.value) : 0 },
  ], [matching, tt]);
  const enterAlpha = useDerivedValue(() =>
    matching
      ? smootherstep(ENTER_START, 1, tt.value)
      : smootherstep(0, 1, tt.value),
  [matching, tt]);
  const enterShift = useDerivedValue(() => [
    {
      translateY: matching
        ? ENTER_RISE * (1 - smootherstep(ENTER_START, 1, tt.value))
        : 0,
    },
  ], [matching, tt]);

  return (
    <>
      <Glyphs
        font={font}
        glyphs={model.exitGlyphs}
        transform={exitShift}
        color={color}
        opacity={exitAlpha}
      />
      {model.kind === 'transform'
        ? model.transformLayers.map((layer, i) => (
            <TransformLayer
              key={`#transform${i}`}
              model={layer}
              tt={tt}
              font={font}
              color={color}
            />
          ))
        : model.morphModels.map((m, i) => (
            <MorphGlyph
              key={`#morph${i}`}
              m={m}
              tt={tt}
              font={font}
              color={color}
              dip={morphDip}
            />
          ))}
      <Glyphs
        font={font}
        glyphs={moverGlyphs}
        color={color}
        opacity={morphDip}
      />
      <Glyphs
        font={font}
        glyphs={model.enterGlyphs}
        transform={enterShift}
        color={color}
        opacity={enterAlpha}
      />
    </>
  );
}

export type MorphTextProps = {
  text: string;
  charStyle: TextStyle;
  color: string;
  /** Morph/crossfade duration. Write uses Manim's automatic duration by default. */
  duration?: number;
  writeDuration?: number;
  /** Existing matching behavior remains the backward-compatible default. */
  variant?: TextMotionVariant;
  /** Applied on first mount and whenever an empty text becomes non-empty. */
  appearance?: TextAppearance;
  /** Outer container — reserve a fixed height so the page never shifts. */
  style?: StyleProp<ViewStyle>;
  /** External 0..1 clock; the component stops driving its own. Read-only
   *  derived clocks are fine — the component never writes to it. */
  progress?: SharedValue<number> | DerivedValue<number>;
};

/**
 * Memoized so unrelated parent commits cannot re-record a ticking Canvas.
 * Each committed generation owns fresh Skia nodes and a fresh born clock.
 */
export const MorphText = React.memo(MorphTextImpl);

function MorphTextImpl({
  text,
  charStyle,
  color,
  duration = DEFAULT_TEXT_TRANSFORM_MS,
  writeDuration,
  variant = 'matching',
  appearance = 'none',
  style,
  progress,
}: MorphTextProps) {
  const idle = useSharedValue(1);
  const reduced = useReducedMotion();
  const font = useMorphFont(charStyle);
  const [width, setWidth] = useState(0);
  const [model, setModel] = useState<Model | null>(null);
  const genRef = useRef(0);

  if (
    font &&
    width > 0 &&
    (model?.text !== text || model.width !== width || model.font !== font ||
      (model.kind !== 'write' && model.kind !== 'settled' && model.kind !== variant && !reduced))
  ) {
    const lineHeight = charStyle.lineHeight ?? (charStyle.fontSize ?? 14) * 1.35;
    const next = layoutText(
      text,
      font,
      charStyle.letterSpacing ?? 0,
      width,
      lineHeight,
      charStyle.textAlign === 'center' ? 'center' : 'left',
    );
    const retarget = model !== null && model.width === width && model.font === font;
    const captureT = progress ? progress.value : model?.clock.value ?? 1;
    const prev = retarget && model ? captureModel(model, captureT) : [];
    const shouldWrite =
      !reduced && appearance === 'write' && next.length > 0 && (!retarget || prev.length === 0);

    let kind: ModelKind;
    let flights: Flights;
    if (shouldWrite) {
      kind = 'write';
      flights = buildCrossfadeFlights([], next);
    } else if (!retarget && appearance === 'none' && !reduced) {
      kind = 'settled';
      flights = buildCrossfadeFlights([], next);
    } else if (reduced || variant === 'crossfade' || (!retarget && appearance === 'fade')) {
      kind = 'crossfade';
      flights = buildCrossfadeFlights(prev, next);
    } else if (variant === 'transform') {
      kind = 'transform';
      flights = buildTransformFlights(prev, next);
    } else {
      kind = 'matching';
      flights = buildFlights(prev, next, width);
    }

    const morphModels = buildMorphModels(font, flights);
    const transformLayers = kind === 'transform' ? buildTransformLayers(morphModels) : [];
    const write = kind === 'write'
      ? buildWriteModels(font, next)
      : { models: [], fallback: [] };
    genRef.current++;
    setModel({
      text,
      width,
      font,
      layout: next,
      kind,
      flights,
      morphModels,
      transformLayers,
      writeModels: write.models,
      writeFallback: write.fallback,
      exitGlyphs: toGlyphs(flights.exits),
      enterGlyphs: toGlyphs(kind === 'settled' ? next : flights.enters),
      clock: bornClock(kind === 'settled' ? 1 : 0),
      animate: kind !== 'settled',
      runTime: kind === 'write' ? (writeDuration ?? writeDurationMs(next.length)) : duration,
      gen: genRef.current,
    });
  }

  // Safe narrowing: everything downstream only ever reads tt.value.
  const tt = (progress ?? model?.clock ?? idle) as SharedValue<number>;

  // No completion commit: all outline→glyph ownership changes stay UI-thread-only.
  useEffect(() => {
    if (!model?.animate || progress) {
      return;
    }
    const clock = model.clock;
    clock.value = withTiming(1, { duration: model.runTime, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [model, progress]);

  return (
    <View
      style={style}
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}>
      {model && font && (
        <Canvas style={StyleSheet.absoluteFill}>
          {model.kind === 'write' ? (
            <>
              {model.writeModels.map((writeModel, i) => (
                <WriteGlyph
                  key={`${model.gen}#write${i}`}
                  model={writeModel}
                  tt={tt}
                  font={font}
                  color={color}
                />
              ))}
              {model.writeFallback.map((box, i) => (
                <WriteFallbackGlyph
                  key={`${model.gen}#fallback${i}`}
                  box={box}
                  index={model.layout.indexOf(box)}
                  count={model.layout.length}
                  tt={tt}
                  font={font}
                  color={color}
                />
              ))}
            </>
          ) : model.kind === 'settled' ? (
            <Glyphs
              key={`set${model.gen}`}
              font={font}
              glyphs={model.enterGlyphs}
              color={color}
            />
          ) : (
            /* One keyed instance per generation: layers AND their reanimated
               bindings remount together, so an outgoing generation can never
               repaint against the next generation's newborn clock. */
            <TransitionGlyphs
              key={`tr${model.gen}`}
              model={model}
              tt={tt}
              font={font}
              color={color}
            />
          )}
        </Canvas>
      )}
    </View>
  );
}

export type MorphTextSequenceItem = {
  key: string;
  initialText: string;
  text: string;
  /** Optional distinct source slot, used when text travels between panels. */
  initialX?: number;
  initialY?: number;
  initialWidth?: number;
  /** Fixed canvas coordinates for this text slot. */
  x: number;
  y: number;
  width: number;
  /** Normalized window on the sequence's external 0..1 clock. */
  start: number;
  end: number;
};

export type MorphTextSequenceProps = {
  items: readonly MorphTextSequenceItem[];
  charStyle: TextStyle;
  color: string;
  progress: SharedValue<number> | DerivedValue<number>;
  /** All initial texts write together inside this normalized clock window. */
  writeWindow?: readonly [number, number];
  style: StyleProp<ViewStyle>;
};

type SequenceItemModel = {
  key: string;
  start: number;
  end: number;
  transformLayers: TransformLayerModel[];
  exitGlyphs: Glyph[];
  enterGlyphs: Glyph[];
};

type SequenceWriteFallback = {
  box: CharBox;
  index: number;
  count: number;
};

type SequenceScene = {
  items: SequenceItemModel[];
  writeModels: WriteModel[];
  writeFallback: SequenceWriteFallback[];
};

function offsetBoxes(boxes: CharBox[], x: number, y: number): CharBox[] {
  return boxes.map(box => ({ ...box, x: box.x + x, y: box.y + y }));
}

/** Fuse the same character index from every source into one write path. */
function buildSequenceWriteModels(
  font: SkFont,
  layouts: CharBox[][],
): Pick<SequenceScene, 'writeModels' | 'writeFallback'> {
  const count = layouts.reduce((max, layout) => Math.max(max, layout.length), 0);
  const pathGroups: SkPath[][] = Array.from({ length: count }, () => []);
  const glyphGroups: Glyph[][] = Array.from({ length: count }, () => []);
  const fallback: { box: CharBox; index: number }[] = [];
  for (const layout of layouts) {
    layout.forEach((box, index) => {
      const path = placedGlyphPath(font, box);
      if (path) {
        pathGroups[index].push(path);
        glyphGroups[index].push(...toGlyphs([box]));
      } else {
        fallback.push({ box, index });
      }
    });
  }
  const writeModels = pathGroups.flatMap((paths, index) => {
    if (paths.length === 0) {
      return [];
    }
    const builder = Skia.PathBuilder.Make();
    paths.forEach(path => builder.addPath(path));
    return [{
      path: builder.build(),
      glyphs: glyphGroups[index],
      index,
      count,
    }];
  });
  return {
    writeModels,
    writeFallback: fallback.map(item => ({ ...item, count })),
  };
}

function SequenceTransform({
  model,
  progress,
  font,
  color,
}: {
  model: SequenceItemModel;
  progress: SharedValue<number> | DerivedValue<number>;
  font: SkFont;
  color: string;
}) {
  const tt = useDerivedValue(() =>
    Math.min(
      1,
      Math.max(0, (progress.value - model.start) / (model.end - model.start)),
    ),
  );
  const exitAlpha = useDerivedValue(() =>
    1 - smootherstep(model.start, model.end, progress.value),
  );
  const enterAlpha = useDerivedValue(() =>
    smootherstep(model.start, model.end, progress.value),
  );
  return (
    <>
      {model.exitGlyphs.length > 0 && (
        <Glyphs
          font={font}
          glyphs={model.exitGlyphs}
          color={color}
          opacity={exitAlpha}
        />
      )}
      {model.transformLayers.map((layer, index) => (
        <TransformLayer
          key={`${model.key}#${index}`}
          model={layer}
          tt={tt}
          font={font}
          color={color}
        />
      ))}
      {model.enterGlyphs.length > 0 && (
        <Glyphs
          font={font}
          glyphs={model.enterGlyphs}
          color={color}
          opacity={enterAlpha}
        />
      )}
    </>
  );
}

/**
 * Several planned text transforms on one canvas. Every endpoint is prepared
 * together, but each item owns a clock window. This avoids a native surface
 * per short label while preserving MorphText's UI-thread terminal hand-off.
 */
export const MorphTextSequence = React.memo(function MorphTextSequenceComponent({
  items,
  charStyle,
  color,
  progress,
  writeWindow,
  style,
}: MorphTextSequenceProps) {
  const font = useMorphFont(charStyle);
  const reduced = useReducedMotion();
  const fontSize = charStyle.fontSize ?? 14;
  const lineHeight = charStyle.lineHeight ?? fontSize * 1.35;
  const letterSpacing = charStyle.letterSpacing ?? 0;
  const centered = charStyle.textAlign === 'center';
  const scene = useMemo<SequenceScene>(() => {
    if (!font) {
      return { items: [], writeModels: [], writeFallback: [] };
    }
    const sourceLayouts: CharBox[][] = [];
    const itemModels = items.map(item => {
      const from = offsetBoxes(
        layoutText(
          item.initialText,
          font,
          letterSpacing,
          item.initialWidth ?? item.width,
          lineHeight,
          centered ? 'center' : 'left',
        ),
        item.initialX ?? item.x,
        item.initialY ?? item.y,
      );
      sourceLayouts.push(from);
      const to = offsetBoxes(
        layoutText(
          item.text,
          font,
          letterSpacing,
          item.width,
          lineHeight,
          centered ? 'center' : 'left',
        ),
        item.x,
        item.y,
      );
      // Reduced motion: no geometry travels — the old text crossfades into
      // the new one inside the same clock window (exits fade, enters rise-less).
      const flights = reduced
        ? buildCrossfadeFlights(from, to)
        : buildTransformFlights(from, to);
      const morphModels = buildMorphModels(font, flights);
      return {
        key: item.key,
        start: item.start,
        end: item.end,
        transformLayers: buildTransformLayers(morphModels),
        exitGlyphs: toGlyphs(flights.exits),
        enterGlyphs: toGlyphs(flights.enters),
      };
    });
    return {
      items: itemModels,
      // Under reduced motion the initial texts simply exist — no write trace.
      ...(reduced
        ? { writeModels: [], writeFallback: [] }
        : buildSequenceWriteModels(font, sourceLayouts)),
    };
  }, [centered, font, items, letterSpacing, lineHeight, reduced]);
  const hasWriteWindow =
    !reduced && writeWindow !== undefined && writeWindow[1] > writeWindow[0];
  const writeStart = writeWindow?.[0] ?? 0;
  const writeEnd = writeWindow?.[1] ?? 0;
  const writeT = useDerivedValue(() =>
    hasWriteWindow
      ? Math.min(
          1,
          Math.max(0, (progress.value - writeStart) / (writeEnd - writeStart)),
        )
      : 1,
  );
  const writeOwner = useDerivedValue<number>(() =>
    hasWriteWindow && progress.value < writeEnd ? 1 : 0,
  );
  const transformOwner = useDerivedValue<number>(() =>
    !hasWriteWindow || progress.value >= writeEnd ? 1 : 0,
  );

  return (
    <View
      style={style}
      accessible
      accessibilityRole="text"
      accessibilityLabel={items.map(item => item.text).join('\n')}>
      <Canvas style={StyleSheet.absoluteFill}>
        {font && (
          <>
            <Group opacity={writeOwner}>
              {scene.writeModels.map((model, index) => (
                <WriteGlyph
                  key={`sequence-write-${index}`}
                  model={model}
                  tt={writeT}
                  font={font}
                  color={color}
                />
              ))}
              {scene.writeFallback.map((fallback, index) => (
                <WriteFallbackGlyph
                  key={`sequence-write-fallback-${index}`}
                  box={fallback.box}
                  index={fallback.index}
                  count={fallback.count}
                  tt={writeT}
                  font={font}
                  color={color}
                />
              ))}
            </Group>
            <Group opacity={transformOwner}>
              {scene.items.map(model => (
                <SequenceTransform
                  key={model.key}
                  model={model}
                  progress={progress}
                  font={font}
                  color={color}
                />
              ))}
            </Group>
          </>
        )}
      </Canvas>
    </View>
  );
});

/** Convenience primitives: one engine, explicit vocabulary at call sites. */
type VariantTextProps = Omit<MorphTextProps, 'variant'>;
type WriteTextProps = Omit<MorphTextProps, 'appearance'>;

export const TransformText = React.memo(function TransformTextComponent(props: VariantTextProps) {
  return <MorphText {...props} variant="transform" />;
});

export const MatchingText = React.memo(function MatchingTextComponent(props: VariantTextProps) {
  return <MorphText {...props} variant="matching" />;
});

export const CrossfadeText = React.memo(function CrossfadeTextComponent(props: VariantTextProps) {
  return <MorphText {...props} variant="crossfade" />;
});

export const WriteText = React.memo(function WriteTextComponent(props: WriteTextProps) {
  return <MorphText {...props} appearance="write" />;
});
