import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Canvas,
  Group,
  PaintStyle,
  Path,
  Picture,
  Skia,
  type SkPath,
} from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { station, type Point } from '../../marks/station';
import { PHONE_SEAL_KNOBS, phoneSeal } from '../../marks/seal';
import type { FaceRecipe } from '../../lenses/face';
import { FACE_MAX_EXTENT } from '../../lenses/face';
import {
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  NAME_LENS_KNOBS,
  nameLensFacePath,
} from '../../lenses/nameLens';
import { availabilityOf } from '../../lenses/availability';
import { ARRIVING_NONE } from '../../lenses/contract';
import type { Lens, LensSong } from '../../lenses/types';
import { useRuleInk, WorkingRule } from './state';
import { usePalette } from '../../theme/tokens';

/** KNOBS — marks drawn in a clef or beside a name. */
export const CLEF_KNOBS = {
  /**
   * How much of its box a mark fills. The drawings are sized by their
   * circumradius, and a polygon or a face at the full half-width touches the
   * box's edge; this leaves the air `folio.html` draws them with (14.5 of 20).
   */
  FILL: 14.5 / 20,
  /** A model dot, as a share of the station's radius, and its floor in px. */
  DOT_RATIO: 1.9 / 14.5,
  DOT_MIN_PX: 1.5,
  /** The phone seal's centre dot, as a share of its radius. */
  SEAL_DOT_RATIO: 1.6 / 14.5,
  /** The working rule under a station, as a share of its size. */
  RULE_HEIGHT: 0.25,
  RULE_WIDTH: 0.6,
  /** Four stations in the nodes clef: each one this much of the whole. */
  CONSTELLATION_SCALE: 0.58,
  CONSTELLATION_OFFSET: 9.5 / 40,
} as const;

/** What a node is doing, as the station inks it. */
export type StationState = 'ready' | 'working' | 'connecting' | 'offline';

function polyline(points: readonly Point[], scale: number): SkPath {
  const builder = Skia.PathBuilder.Make();
  points.forEach(([x, y], index) => {
    if (index === 0) builder.moveTo(x * scale, y * scale);
    else builder.lineTo(x * scale, y * scale);
  });
  return builder.detach();
}

function stationPaths(
  nodePublicKey: string,
  models: number,
  radius: number,
  dotPx: number,
): { outline: SkPath; dots: SkPath } {
  const mark = station(nodePublicKey, models);
  const dots = Skia.PathBuilder.Make();
  for (const [x, y] of mark.dots) dots.addCircle(x * radius, y * radius, dotPx);
  return { outline: polyline(mark.outline, radius), dots: dots.detach() };
}

/**
 * A node's station: its key-derived polygon with the gate left open, and a
 * dot per installed model. Ink when it answers, faint when it does not, and
 * the working rule under it while it is making a song.
 */
export function StationMark({
  models,
  nodePublicKey,
  size,
  state = 'ready',
}: {
  models: number;
  nodePublicKey: string;
  size: number;
  state?: StationState;
}) {
  const pal = usePalette();
  const radius = (size / 2) * CLEF_KNOBS.FILL;
  const dotPx = Math.max(CLEF_KNOBS.DOT_MIN_PX, radius * CLEF_KNOBS.DOT_RATIO);
  const { outline, dots } = useMemo(
    () => stationPaths(nodePublicKey, models, radius, dotPx),
    [dotPx, models, nodePublicKey, radius],
  );
  const colour = state === 'offline' ? pal.faint : pal.ink;
  const working = state === 'working';
  const drawing = useRuleInk(working);
  return (
    <View style={{ width: size }}>
      <Canvas style={{ width: size, height: size }}>
        <Group transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}>
          <Path
            color={colour}
            path={outline}
            strokeCap="round"
            strokeJoin="round"
            strokeWidth={1}
            style="stroke"
          />
          <Path color={colour} path={dots} />
        </Group>
      </Canvas>
      {drawing ? (
        <WorkingRule
          colour={pal.ink}
          style={[
            styles.rule,
            {
              height: size * CLEF_KNOBS.RULE_HEIGHT,
              width: size * CLEF_KNOBS.RULE_WIDTH,
            },
          ]}
          working={working}
        />
      ) : null}
    </View>
  );
}

/** A node as the nodes panel's clef sees it: its key, models and state. */
export type ConstellationNode = Readonly<{
  nodePublicKey: string;
  models: number;
  state: StationState;
}>;

/**
 * The nodes panel's clef: up to four of the paired nodes' stations, small, in
 * the corners of one mark — the panel's subject is all of them.
 */
export function Constellation({
  nodes,
  size,
}: {
  nodes: readonly ConstellationNode[];
  size: number;
}) {
  const pal = usePalette();
  const cell = size * CLEF_KNOBS.CONSTELLATION_SCALE;
  const radius = (cell / 2) * CLEF_KNOBS.FILL;
  const offset = size * CLEF_KNOBS.CONSTELLATION_OFFSET;
  const shown = nodes.slice(0, 4);
  const marks = useMemo(
    () =>
      shown.map(node =>
        stationPaths(
          node.nodePublicKey,
          node.models,
          radius,
          Math.max(1, radius * CLEF_KNOBS.DOT_RATIO),
        ),
      ),
    // Keyed by what draws them, not by the array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [radius, shown.map(node => `${node.nodePublicKey}:${node.models}`).join()],
  );
  return (
    <Canvas style={{ width: size, height: size }}>
      {marks.map((mark, index) => {
        const colour = shown[index].state === 'offline' ? pal.faint : pal.ink;
        const alone = shown.length === 1;
        const x = alone ? 0 : index % 2 === 1 ? offset : -offset;
        const y = alone ? 0 : index < 2 ? -offset : offset;
        return (
          <Group
            key={shown[index].nodePublicKey}
            transform={[
              { translateX: size / 2 + x },
              { translateY: size / 2 + y },
            ]}
          >
            <Path
              color={colour}
              path={mark.outline}
              strokeJoin="round"
              strokeWidth={1}
              style="stroke"
            />
            <Path color={colour} path={mark.dots} />
          </Group>
        );
      })}
    </Canvas>
  );
}

/**
 * This phone's seal: a circle with spokes from its public key, and a dot at
 * the centre. Settings' clef.
 *
 * With `spindle` it is the phone as a place music lives (the nodes roster and
 * the phone's page): the ring every imported song carries where the dot was.
 * `faint` when nothing is read or reading is not allowed; `working` grows the
 * working rule under it while music is brought in, as a station's does.
 */
export function PhoneSealMark({
  publicKey,
  size,
  spindle = false,
  faint = false,
  working = false,
}: {
  publicKey: string;
  size: number;
  spindle?: boolean;
  faint?: boolean;
  working?: boolean;
}) {
  const pal = usePalette();
  const radius = (size / 2) * CLEF_KNOBS.FILL;
  const path = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    builder.addCircle(0, 0, radius);
    for (const [[x0, y0], [x1, y1]] of phoneSeal(publicKey, spindle).spokes) {
      builder.moveTo(x0 * radius, y0 * radius);
      builder.lineTo(x1 * radius, y1 * radius);
    }
    if (spindle) {
      builder.addCircle(0, 0, radius * PHONE_SEAL_KNOBS.SPINDLE_RING);
    }
    return builder.detach();
  }, [publicKey, radius, spindle]);
  const dot = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    builder.addCircle(0, 0, Math.max(1.2, radius * CLEF_KNOBS.SEAL_DOT_RATIO));
    return builder.detach();
  }, [radius]);
  const colour = faint ? pal.faint : pal.ink;
  const drawing = useRuleInk(working);
  return (
    <View style={{ width: size }}>
      <Canvas style={{ width: size, height: size }}>
        <Group transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}>
          <Path
            color={colour}
            path={path}
            strokeCap="round"
            strokeWidth={1}
            style="stroke"
          />
          {spindle ? null : <Path color={colour} path={dot} />}
        </Group>
      </Canvas>
      {drawing ? (
        <WorkingRule
          colour={pal.ink}
          style={[
            styles.rule,
            {
              height: size * CLEF_KNOBS.RULE_HEIGHT,
              width: size * CLEF_KNOBS.RULE_WIDTH,
            },
          ]}
          working={working}
        />
      ) : null}
    </View>
  );
}

/** What a song clef draws from: the recipe, and how much of it is here. */
export type SongClefSong = Pick<
  LensSong,
  'id' | 'seed' | 'model' | 'durationMs' | 'audioState'
> &
  Readonly<{ imported?: boolean }>;

/**
 * A song's clef, drawn by the lens the person has chosen — the same identity
 * and the same availability ink the field draws it with: grey on the node,
 * firm when cached, filled when downloaded (`lenses/nameLens.ts`).
 *
 * The circle is drawn as its own contour so it can be traced on (`traced`,
 * 0..1, the sheet's arrival); any other lens is recorded once through its own
 * `drawMark` and appears whole.
 */
export function SongClef({
  lens,
  size,
  song,
  traced,
}: {
  lens: Lens;
  size: number;
  song: SongClefSong;
  traced?: SharedValue<number>;
}) {
  const pal = usePalette();
  const availability = availabilityOf(song.audioState);
  const stroke = FACE_STROKE_ALPHA[availability];
  const fill = FACE_FILL_ALPHA[availability];
  /** The face at scale 1 reaches this far; a clef is scaled to fill its box. */
  const scale =
    ((size / 2) * CLEF_KNOBS.FILL) /
    (NAME_LENS_KNOBS.MARK_RADIUS_PX * FACE_MAX_EXTENT);
  const recipe: FaceRecipe = {
    seed: song.seed,
    id: song.id,
    model: song.model,
    durationMs: song.durationMs,
  };
  const circle = lens.key === 'name';
  const fillIn = useDerivedValue(() =>
    traced === undefined ? fill : fill * traced.value,
  );
  const face = useMemo(
    () =>
      circle
        ? nameLensFacePath(
            {
              seed: song.seed,
              id: song.id,
              model: song.model,
              durationMs: song.durationMs,
              imported: song.imported,
            },
            NAME_LENS_KNOBS.MARK_RADIUS_PX * scale,
          )
        : null,
    [
      circle,
      scale,
      song.durationMs,
      song.id,
      song.imported,
      song.model,
      song.seed,
    ],
  );
  const picture = useMemo(() => {
    if (circle) return null;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, size, size));
    const fillPaint = Skia.Paint();
    fillPaint.setColor(Skia.Color(pal.ink));
    fillPaint.setAntiAlias(true);
    const strokePaint = Skia.Paint();
    strokePaint.setColor(Skia.Color(pal.ink));
    strokePaint.setAntiAlias(true);
    strokePaint.setStyle(PaintStyle.Stroke);
    canvas.translate(size / 2, size / 2);
    lens.ui.drawMark(
      canvas,
      lens.identity(recipe),
      scale,
      1,
      stroke,
      fill,
      0,
      ARRIVING_NONE,
      1,
      { fill: fillPaint, stroke: strokePaint },
    );
    return recorder.finishRecordingAsPicture();
    // The recipe's parts are the dependencies; `recipe` is rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    circle,
    fill,
    lens,
    pal.ink,
    scale,
    size,
    song.durationMs,
    song.id,
    song.model,
    song.seed,
    stroke,
  ]);
  return (
    <Canvas style={{ width: size, height: size }}>
      {face !== null ? (
        <Group transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}>
          {fill > 0 ? (
            // A fill cannot be traced; it comes in with the line instead.
            <Path color={pal.ink} opacity={fillIn} path={face} />
          ) : null}
          <Path
            color={pal.ink}
            end={traced}
            opacity={stroke}
            path={face}
            start={0}
            strokeWidth={1}
            style="stroke"
          />
        </Group>
      ) : picture !== null ? (
        <Picture picture={picture} />
      ) : null}
    </Canvas>
  );
}

const styles = StyleSheet.create({
  rule: { alignSelf: 'center' },
});
