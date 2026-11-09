import { ImageFormat, PaintStyle, Skia } from '@shopify/react-native-skia';
import { ARRIVING_NONE } from '../lenses/contract';
import { FACE_MAX_EXTENT, type FaceRecipe } from '../lenses/face';
import {
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  NAME_LENS_KNOBS,
} from '../lenses/nameLens';
import type { Lens } from '../lenses/types';

/** KNOBS — the cover an exported file carries. */
export const COVER_KNOBS = {
  /** Its side, in pixels: large enough for a player's full-screen art. */
  SIDE_PX: 1000,
  /** How much of the side the face spans, as the clef sizes its own. */
  FILL: 0.72,
  /**
   * The face's line on the cover, in pixels. The field's hairline is one
   * screen pixel; at 1000 px a player shows the cover at a third of that or
   * less, where 1 px would vanish.
   */
  HAIRLINE_PX: 3,
  /** Paper and ink: black on white whatever the phone's theme. */
  PAPER: '#FFFFFF',
  INK: '#000000',
} as const;

export type Cover = Readonly<{
  /** PNG, base64. */
  png: string;
  width: number;
  height: number;
}>;

/**
 * A song's face in `lens`, alone on paper, as a PNG (D7 in
 * internal/docs/plans/take-it-plan.md): the lens's own `drawMark`, the same
 * call the sheet's clef makes, never a drawing made for the cover. Drawn as a
 * song you have, full ink, because an exported song is one.
 *
 * Null when Skia cannot make the surface; a file goes without a cover rather
 * than not at all.
 */
export function renderCover(lens: Lens, recipe: FaceRecipe): Cover | null {
  const { SIDE_PX, FILL, HAIRLINE_PX, PAPER, INK } = COVER_KNOBS;
  const surface = Skia.Surface.Make(SIDE_PX, SIDE_PX);
  if (surface === null) return null;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(PAPER));
  const fill = Skia.Paint();
  fill.setColor(Skia.Color(INK));
  fill.setAntiAlias(true);
  const stroke = Skia.Paint();
  stroke.setColor(Skia.Color(INK));
  stroke.setAntiAlias(true);
  stroke.setStyle(PaintStyle.Stroke);
  const scale =
    ((SIDE_PX / 2) * FILL) / (NAME_LENS_KNOBS.MARK_RADIUS_PX * FACE_MAX_EXTENT);
  canvas.save();
  canvas.translate(SIDE_PX / 2, SIDE_PX / 2);
  lens.ui.drawMark(
    canvas,
    lens.identity(recipe),
    scale,
    1,
    FACE_STROKE_ALPHA.downloaded,
    FACE_FILL_ALPHA.downloaded,
    0,
    ARRIVING_NONE,
    HAIRLINE_PX,
    { fill, stroke },
  );
  canvas.restore();
  surface.flush();
  const png = surface.makeImageSnapshot().encodeToBase64(ImageFormat.PNG, 100);
  return png.length > 0 ? { png, width: SIDE_PX, height: SIDE_PX } : null;
}
