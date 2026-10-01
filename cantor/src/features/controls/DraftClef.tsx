import React, { useEffect, useMemo, useRef } from 'react';
import {
  Canvas,
  DashPathEffect,
  Group,
  Path,
  Skia,
} from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  FACE_KNOBS,
  FACE_MAX_EXTENT,
  facePoints,
  type FaceRecipe,
} from '../../lenses/face';
import { NAME_LENS_KNOBS } from '../../lenses/nameLens';
import { sealMarkOf } from '../../lenses/sealLens';
import type { Lens } from '../../lenses/types';
import { CLEF_KNOBS } from './Clef';
import { usePalette } from '../../theme/tokens';

/**
 * KNOBS — the composer's clef: the face of a song not made yet
 * (`folio.html` frame `f-comp`, F8).
 */
export const DRAFT_CLEF_KNOBS = {
  /** How long one recipe's face takes to become the next one's. Linear. */
  MORPH_MS: 420,
  /** The dashes of a face whose length the model will choose. */
  DASH_PX: 2.2,
  GAP_PX: 3,
} as const;

/**
 * The length an `auto` face is drawn at: the middle of the duration cycle,
 * where the face's eccentricity is neutral — neither stretched nor squat,
 * because the length is not decided yet.
 */
export const NEUTRAL_DURATION_MS = (FACE_KNOBS.DURATION_CYCLE_S / 2) * 1000;

/** What the draft would be: a seed, a model, and a length or `auto` (null). */
export type DraftRecipe = Readonly<{
  seed: number;
  model: string;
  durationMs: number | null;
}>;

function recipeOf(draft: DraftRecipe): FaceRecipe {
  return {
    seed: draft.seed,
    // Never read while a seed is present (`faceSeed`); a recipe needs one.
    id: 'draft',
    model: draft.model,
    durationMs: draft.durationMs ?? NEUTRAL_DURATION_MS,
  };
}

/**
 * The draft's face, in the active lens, from the seed the composer will send:
 * so the song that lands wears the face it was previewed with.
 *
 * The model changes the face; the length changes its eccentricity; `auto` is
 * drawn dashed at neutral width and settles when the song lands. The caption
 * never changes it. A recipe change morphs on the lens's own geometry — the
 * circle point by point on a linear clock (`facePoints` has the same count for
 * every recipe), the seal in two beats (the dots that differ scale out, then
 * the new ones scale in, from `sealMarkOf`). Never a crossfade.
 */
export function DraftClef({
  draft,
  lens,
  size,
}: {
  draft: DraftRecipe;
  lens: Lens;
  size: number;
}) {
  const pal = usePalette();
  const reducedMotion = useReducedMotion();
  const scale =
    ((size / 2) * CLEF_KNOBS.FILL) /
    (NAME_LENS_KNOBS.MARK_RADIUS_PX * FACE_MAX_EXTENT);
  const seal = lens.key === 'seal';
  const recipe = recipeOf(draft);
  const key = `${draft.seed}\u001f${draft.model}\u001f${recipe.durationMs}`;

  // ---- The circle: one contour, morphed point by point. ----
  const target = useMemo(() => {
    const radius = NAME_LENS_KNOBS.MARK_RADIUS_PX * scale;
    return facePoints(recipe).flatMap(point => [
      point.x * radius,
      point.y * radius,
    ]);
    // `recipe` is rebuilt per render; `key` is what it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scale]);
  const from = useSharedValue<readonly number[]>(target);
  const to = useSharedValue<readonly number[]>(target);

  // ---- The seal: its dust, in two beats. ----
  const dust = useMemo(() => {
    const mark = sealMarkOf(recipe);
    const dots: number[] = [];
    for (let index = 0; index < mark.x.length; index += 1) {
      dots.push(mark.x[index] * scale, mark.y[index] * scale);
    }
    return { dots, radius: mark.radius * scale };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scale]);
  const leaving = useSharedValue<readonly number[]>([]);
  const staying = useSharedValue<readonly number[]>(dust.dots);
  const arriving = useSharedValue<readonly number[]>([]);

  const progress = useSharedValue(1);
  const shown = useRef(key);
  const shownDust = useRef(dust.dots);
  useEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    // From wherever the drawing is now, so a change mid-morph does not snap.
    const t = progress.value;
    const a = from.value;
    const b = to.value;
    from.value =
      a.length === b.length
        ? a.map((value, i) => value + (b[i] - value) * t)
        : b;
    to.value = target;
    const before = shownDust.current;
    const after = dust.dots;
    const keyOf = (dots: readonly number[], i: number) =>
      `${dots[i].toFixed(2)},${dots[i + 1].toFixed(2)}`;
    const had = new Set<string>();
    for (let i = 0; i < before.length; i += 2) had.add(keyOf(before, i));
    const has = new Set<string>();
    for (let i = 0; i < after.length; i += 2) has.add(keyOf(after, i));
    const stay: number[] = [];
    const out: number[] = [];
    const inn: number[] = [];
    for (let i = 0; i < before.length; i += 2)
      (has.has(keyOf(before, i)) ? stay : out).push(before[i], before[i + 1]);
    for (let i = 0; i < after.length; i += 2)
      if (!had.has(keyOf(after, i))) inn.push(after[i], after[i + 1]);
    staying.value = stay;
    leaving.value = out;
    arriving.value = inn;
    shownDust.current = after;
    progress.value = 0;
    progress.value = reducedMotion
      ? 1
      : withTiming(1, {
          duration: DRAFT_CLEF_KNOBS.MORPH_MS,
          easing: Easing.linear,
        });
  }, [
    arriving,
    dust.dots,
    from,
    key,
    leaving,
    progress,
    reducedMotion,
    staying,
    target,
    to,
  ]);

  const contour = useDerivedValue(() => {
    const a = from.value;
    const b = to.value;
    const t = progress.value;
    const builder = Skia.PathBuilder.Make();
    for (let i = 0; i < b.length; i += 2) {
      const x = a.length === b.length ? a[i] + (b[i] - a[i]) * t : b[i];
      const y =
        a.length === b.length ? a[i + 1] + (b[i + 1] - a[i + 1]) * t : b[i + 1];
      if (i === 0) builder.moveTo(x, y);
      else builder.lineTo(x, y);
    }
    builder.close();
    return builder.detach();
  });

  const radius = dust.radius;
  const dots = useDerivedValue(() => {
    const t = progress.value;
    // The first beat takes the leavers away; the second brings the new in.
    const out = t < 0.5 ? 1 - t * 2 : 0;
    const inn = t < 0.5 ? 0 : (t - 0.5) * 2;
    const builder = Skia.PathBuilder.Make();
    const add = (list: readonly number[], grow: number) => {
      if (grow <= 0.001) return;
      for (let i = 0; i < list.length; i += 2)
        builder.addCircle(list[i], list[i + 1], radius * grow);
    };
    add(staying.value, 1);
    add(leaving.value, out);
    add(arriving.value, inn);
    return builder.detach();
  });

  const unsettled = draft.durationMs === null;
  return (
    <Canvas style={{ width: size, height: size }}>
      <Group transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}>
        {seal ? (
          // An unsettled seal is drawn as the dust of a song not here yet.
          <Path color={unsettled ? pal.faint : pal.ink} path={dots} />
        ) : (
          <Path
            color={pal.ink}
            path={contour}
            strokeJoin="round"
            strokeWidth={1}
            style="stroke"
          >
            {unsettled ? (
              <DashPathEffect
                intervals={[DRAFT_CLEF_KNOBS.DASH_PX, DRAFT_CLEF_KNOBS.GAP_PX]}
              />
            ) : null}
          </Path>
        )}
      </Group>
    </Canvas>
  );
}

/** A fresh seed for a draft: a 32-bit integer, exact in JSON and in a face. */
export function draftSeed(random: () => number = Math.random): number {
  return Math.min(Math.floor(random() * 0x1_0000_0000), 0xffff_ffff);
}
