import type { SkPicture } from '@shopify/react-native-skia';
import type { Camera } from '../../field';

/**
 * A picture of the map held while the camera only pans.
 *
 * At a fixed zoom the whole map moves as one rigid sheet, yet its pictures
 * (the faces, the rows and names) were recorded anew on every frame of every
 * pan and fling: ~4.4 ms of the Xiaomi's UI thread a frame at 872 songs, over
 * half of a 120 Hz frame. Here the map is recorded once, past the edges of the
 * screen by `MARGIN_PX`, and a frame only shifts it by how far the camera has
 * moved since. It is recorded again when the camera nears the edge of what was
 * recorded — centred a little ahead of the pan, so a fling spends its margin
 * on the side it is going — or when anything else it is drawn from changes
 * (its `key`: null means "not now", and the frame is drawn plain).
 */

/** KNOBS */
export const PAN_KNOBS = {
  /** How far past each edge of the screen the held picture reaches, in px. */
  MARGIN_PX: 320,
  /** The share of the margin the camera may use before a new recording. */
  REUSE: 0.7,
  /** How far ahead of the pan a new recording is centred, as a share of the margin. */
  LEAD: 0.5,
} as const;

export type PanHeld = {
  key: readonly unknown[] | null;
  picture: SkPicture | null;
  /** The camera the held picture was recorded at. */
  x: number;
  y: number;
  /** The camera at the last frame, for the direction of a pan. */
  lastX: number;
  lastY: number;
};

/** What to draw this frame: a picture, shifted by (`tx`, `ty`) pixels. */
export type PanFrame = Readonly<{ picture: SkPicture; tx: number; ty: number }>;

/**
 * Names, to the derived value that calls it, the shared values its `record`
 * reads.
 *
 * Reanimated re-runs a derived value when a shared value in its own closure
 * changes, and finds them in arrays and plain objects but never inside a
 * function it calls. `record` is such a function: what only it read was
 * invisible, and a change to it recorded nothing — after find, a lens change
 * left the found song's player in the lens it had been in. Called with every
 * shared value `record` reads that the derived value does not, it puts them in
 * the closure; it does nothing else.
 */
export function listensTo(_inputs: readonly unknown[]): void {
  'worklet';
}

export function newPanHeld(): PanHeld {
  return { key: null, picture: null, x: 0, y: 0, lastX: NaN, lastY: NaN };
}

export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  'worklet';
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

/**
 * This frame's picture. `record(camera, margin)` draws the map as `camera`
 * sees it, on a canvas `margin` pixels bigger than the screen on every side.
 */
export function panFrame(
  held: PanHeld,
  key: readonly unknown[] | null,
  camera: Camera,
  record: (camera: Camera, marginPx: number) => SkPicture,
): PanFrame {
  'worklet';
  const lastX = held.lastX;
  const lastY = held.lastY;
  held.lastX = camera.x;
  held.lastY = camera.y;
  if (key === null) {
    held.key = null;
    held.picture = null;
    return { picture: record(camera, 0), tx: 0, ty: 0 };
  }
  const margin = PAN_KNOBS.MARGIN_PX;
  if (held.picture !== null && held.key !== null && sameKey(held.key, key)) {
    const dx = (held.x - camera.x) * camera.scale;
    const dy = (held.y - camera.y) * camera.scale;
    const reach = margin * PAN_KNOBS.REUSE;
    if (Math.abs(dx) <= reach && Math.abs(dy) <= reach) {
      return { picture: held.picture, tx: dx - margin, ty: dy - margin };
    }
  }
  let x = camera.x;
  let y = camera.y;
  const vx = camera.x - lastX;
  const vy = camera.y - lastY;
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed > 0 && speed < Infinity) {
    const lead = (margin * PAN_KNOBS.LEAD) / camera.scale;
    x += (vx / speed) * lead;
    y += (vy / speed) * lead;
  }
  const picture = record({ x, y, scale: camera.scale }, margin);
  held.key = key;
  held.picture = picture;
  held.x = x;
  held.y = y;
  return {
    picture,
    tx: (x - camera.x) * camera.scale - margin,
    ty: (y - camera.y) * camera.scale - margin,
  };
}
