import type { SkCanvas, SkPath } from '@shopify/react-native-skia';
import { smootherstep } from '../field/bands';
import type {
  LensIdentity,
  LensPairMorph,
  LensPlayer,
  PlayerPaints,
} from './contract';
import { NAME_LENS_KNOBS } from './nameLens';
import { sealSidePx } from './sealLens';
import { drawSealPlayer, type SealPlayer } from './sealPlayer';

/** The seal at the mark's size, as `sealLens` draws it. */
const SEAL_MARK_SIDE_PX = sealSidePx(NAME_LENS_KNOBS.MARK_RADIUS_PX);

/**
 * The circle becoming the seal, at the player.
 *
 * Every dot starts as a point on the face's contour where the circle's clock
 * stands at that dot's moment, and the contour itself is the thread; as `t`
 * runs the points walk to their cells and grow into dots, and the line becomes
 * the Peano thread (`drawSealPlayer`'s `formed`). Under it, a downloaded
 * song's filled face gives its ink back as the dots take it. One drawing
 * throughout — nothing is swapped for anything else. Run backwards, it is the
 * seal becoming the circle.
 */
function drawCircleSealMorph(
  canvas: SkCanvas,
  circle: LensIdentity,
  _circlePlayer: LensPlayer | null,
  _seal: LensIdentity,
  sealPlayer: LensPlayer | null,
  t: number,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  soundIn: number,
  heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  if (sealPlayer === null) return;
  const formed = smootherstep(t);
  if (fill > 0 && arrived < 1) {
    canvas.save();
    canvas.scale(size, size);
    paints.fill.setAlphaf(alpha * weight * fill * (1 - arrived) * (1 - formed));
    canvas.drawPath(circle as SkPath, paints.fill);
    canvas.restore();
  }
  // The circle's own line at the player (`drawCircleMark`), which the thread
  // carries until the seal's takes it over.
  const faceLine =
    weight + (NAME_LENS_KNOBS.SONG_FACE_ALPHA - weight) * arrived;
  drawSealPlayer(
    canvas,
    sealPlayer as SealPlayer,
    paints,
    SEAL_MARK_SIDE_PX * size,
    alpha,
    weight + (1 - weight) * fill,
    fill,
    arrived,
    arriving,
    soundIn,
    heard,
    hairlinePx,
    formed,
    faceLine,
  );
}

/** Every hand-written player morph. A pair missing here takes the two beats. */
export const PAIR_MORPHS: readonly LensPairMorph[] = [
  { a: 'name', b: 'seal', drawPlayer: drawCircleSealMorph },
];
