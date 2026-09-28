import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import type { LensIdentity, LensPlayer, PlayerPaints } from './contract';
import type { CoverArt } from './cover';
import { drawCircleMark, nameLens } from './nameLens';
import { SEAL_MARK_SIDE_PX, sealLens, sealRimAt } from './sealLens';
import type { Lens } from './types';

/** KNOBS — the cover's glyphs, in a cell's own width. */
export const COVER_LENS_KNOBS = {
  /** How far a glyph reaches from its cell's centre: air between neighbours. */
  GLYPH_REACH: 0.36,
  /** The dot, `·`: a stroke this long, so it is ink and not a speck. */
  DOT_REACH: 0.07,
  /** Where `#`'s two rails stand either side of the centre. */
  RAIL_OFFSET: 0.16,
  /**
   * The cover's side, over the seal's: the same room the dust fills, whose
   * corners the seal already keeps inside the rim.
   */
  SIDE_RATIO: 1,
} as const;

/**
 * The cover lens's player: its glyphs as one path at the mark's scale. It
 * is the lens's `sound` too — what the renderer waits for before letting the
 * picture rise (`LensPlayer`).
 */
type CoverPlayer = Readonly<{ sound: SkPath }>;

const COVER_SIDE_PX = SEAL_MARK_SIDE_PX * COVER_LENS_KNOBS.SIDE_RATIO;

const COVER_PATH_CACHE_LIMIT = 16;
const coverPathCache = new Map<Uint8Array, SkPath>();

/**
 * Every cell's glyph as one path, centred on the origin, `side` wide: one
 * path because the cover is one drawing, and a thousand strokes per frame
 * would be a thousand draws.
 */
export function coverPath(art: CoverArt, side: number = COVER_SIDE_PX): SkPath {
  const cached = coverPathCache.get(art.levels);
  if (cached !== undefined && side === COVER_SIDE_PX) return cached;
  const cell = side / art.cells;
  const reach = cell * COVER_LENS_KNOBS.GLYPH_REACH;
  const rail = cell * COVER_LENS_KNOBS.RAIL_OFFSET;
  const dot = cell * COVER_LENS_KNOBS.DOT_REACH;
  const builder = Skia.PathBuilder.Make();
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    builder.moveTo(x0, y0);
    builder.lineTo(x1, y1);
  };
  for (let row = 0; row < art.cells; row += 1) {
    for (let column = 0; column < art.cells; column += 1) {
      const level = art.levels[row * art.cells + column];
      if (level === 0) continue;
      const x = -side / 2 + (column + 0.5) * cell;
      const y = -side / 2 + (row + 0.5) * cell;
      const minus = () => line(x - reach, y, x + reach, y);
      const bar = () => line(x, y - reach, x, y + reach);
      const cross = () => {
        line(x - reach, y - reach, x + reach, y + reach);
        line(x - reach, y + reach, x + reach, y - reach);
      };
      // `·  -  +  ×  #  *`, in order of how much line each glyph is.
      if (level === 1) line(x - dot, y, x + dot, y);
      else if (level === 2) minus();
      else if (level === 3) {
        minus();
        bar();
      } else if (level === 4) cross();
      else if (level === 5) {
        line(x - reach, y - rail, x + reach, y - rail);
        line(x - reach, y + rail, x + reach, y + rail);
        line(x - rail, y - reach, x - rail, y + reach);
        line(x + rail, y - reach, x + rail, y + reach);
      } else {
        minus();
        bar();
        cross();
      }
    }
  }
  const path = builder.detach();
  if (side === COVER_SIDE_PX) {
    if (coverPathCache.size >= COVER_PATH_CACHE_LIMIT) {
      const oldest = coverPathCache.keys().next().value;
      if (oldest !== undefined) coverPathCache.delete(oldest);
    }
    coverPathCache.set(art.levels, path);
  }
  return path;
}

/**
 * The cover as the player: the circle grows into it exactly as it grows into
 * its own player, and once the camera has arrived the face gives way and the
 * cover writes itself in on the sound's clock (`soundIn`). A song with no
 * cover — anything a node made, a file with no picture — is the circle's
 * player, which is what it would be under the circle anyway.
 */
function drawCoverPlayer(
  canvas: SkCanvas,
  player: LensPlayer | null,
  identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  soundIn: number,
  _heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  const cover = player === null ? null : (player as CoverPlayer).sound;
  const shown = cover === null ? 0 : soundIn * arrived;
  if (shown < 1) {
    drawCircleMark(
      canvas,
      identity,
      size,
      alpha * (1 - shown),
      weight,
      fill,
      arrived,
      arriving,
      hairlinePx,
      paints,
    );
  }
  if (cover === null || shown <= 0) return;
  canvas.save();
  canvas.scale(size, size);
  paints.stroke.setAlphaf(alpha * shown);
  paints.stroke.setStrokeWidth(hairlinePx / size);
  canvas.drawPath(cover, paints.stroke);
  canvas.restore();
}

export const coverLens: Lens = {
  key: 'cover',
  label: 'Cover',
  // Marks and rows are the circle's: a cover is one picture per album, and
  // at L0 the song's own identity is what tells a record's tracks apart.
  identity: nameLens.identity,
  player: (_recipe, _analysis, cover) =>
    cover === null ? null : { sound: coverPath(cover) },
  // The seal's rim is the clock and the seek; the picture inside it is not a
  // timeline, so a touch on it means nothing.
  touch: {
    reachRatio: sealLens.touch.reachRatio,
    landAt: (_recipe, dx, dy, radius) => {
      const fraction = sealRimAt(dx, dy, radius);
      return fraction === null ? null : { kind: 'seek', fraction };
    },
    seekAt: (dx, dy, radius) => sealRimAt(dx, dy, radius),
  },
  ui: {
    drawMark: drawCircleMark,
    drawPlayer: drawCoverPlayer,
    ringTicks: 0,
    hearsPlayhead: 0,
    clock: sealLens.ui.clock,
  },
};
