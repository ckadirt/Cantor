import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import { FACE_FILL_ALPHA, FACE_STROKE_ALPHA, NAME_LENS_KNOBS, nameLens } from '../nameLens';
import { sealLens } from '../sealLens';
import { faceSeed, hash, mulberry32, type FaceRecipe } from '../face';
import { ARRIVING_NONE, type MarkPaints } from '../contract';
import { MARBLE_MARK_REACH_PX, drawMarbleMark, marbleMarkOf } from '../marbleMark';

/*
 * The marbling plan's M0 line-up (internal/docs/interfacealpha/marbling-plan.md): the
 * four candidate marks mixed on one field at the size they stand at, in every
 * ink and both palettes, so the lens can be judged where it has to live. The
 * circle, the seal and marbling are the app's own drawing; the Spirograph is
 * the page's (`lenses-four.html`, `SPIRO.mark`), ported here, since it has no
 * code in the app.
 *
 * `MARBLE_LINEUP=/dir` writes the sheets out; without it this only checks
 * that every mark draws.
 */
declare const require: (name: string) => { writeFileSync: (path: string, data: Uint8Array) => void };
declare const process: { env: Record<string, string | undefined> };

/** The Xiaomi's density: one dp is this many pixels. */
const DENSITY = 2.75;
/** How far apart the marks stand, dp: a cluster at the fit scale. */
const PITCH = 30;
const MODELS = ['ace-step', 'yue', 'diffrhythm', 'songbloom'];
const STATES = ['not-synced', 'cached', 'downloaded'] as const;

/* eslint-disable no-bitwise */
function spiroModel(rec: FaceRecipe) {
  const q = mulberry32((faceSeed(rec) ^ hash('spiro')) >>> 0);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const p = 5 + Math.floor(q() * 9);
  let w: number;
  do {
    w = 2 + Math.floor(q() * Math.min(6, p - 2));
  } while (gcd(p, w) !== 1);
  const h = 0.5 + 0.7 * q();
  return { p, w, d0: h * w, rot: q() * Math.PI * 2 };
}
/* eslint-enable no-bitwise */

/** The page's Spirograph mark: the closed rosette, its lace filled even-odd. */
function drawSpiro(canvas: SkCanvas, rec: FaceRecipe, reach: number, line: number, fill: number, hairline: number, paints: MarkPaints) {
  const m = spiroModel(rec);
  const s = reach / (m.p - m.w + m.d0);
  const n = 60 * m.w;
  const builder = Skia.PathBuilder.Make();
  builder.setFillType(1);
  for (let i = 0; i <= n; i++) {
    const th = (Math.PI * 2 * m.w * i) / n;
    const a = -Math.PI / 2 + th;
    const b = (-(m.p - m.w) / m.w) * th + m.rot;
    const x = ((m.p - m.w) * Math.cos(a) + m.d0 * Math.cos(b)) * s;
    const y = ((m.p - m.w) * Math.sin(a) + m.d0 * Math.sin(b)) * s;
    if (i === 0) builder.moveTo(x, y);
    else builder.lineTo(x, y);
  }
  builder.close();
  const path = builder.detach();
  if (fill > 0) {
    paints.fill.setAlphaf(fill);
    canvas.drawPath(path, paints.fill);
  }
  paints.stroke.setAlphaf(line);
  paints.stroke.setStrokeWidth(hairline);
  canvas.drawPath(path, paints.stroke);
}

type Lens = 'circle' | 'seal' | 'marble' | 'spiro';
const LENS_ORDER: Lens[] = ['circle', 'seal', 'marble', 'spiro'];

function drawOne(canvas: SkCanvas, lens: Lens, rec: FaceRecipe, state: (typeof STATES)[number], paints: MarkPaints) {
  const weight = FACE_STROKE_ALPHA[state];
  const fill = FACE_FILL_ALPHA[state];
  const hairline = 1;
  if (lens === 'circle') {
    nameLens.ui.drawMark(canvas, nameLens.identity(rec), 1, 1, weight, fill, 0, ARRIVING_NONE, hairline, paints);
  } else if (lens === 'seal') {
    sealLens.ui.drawMark(canvas, sealLens.identity(rec), 1, 1, weight, fill, 0, ARRIVING_NONE, hairline, paints);
  } else if (lens === 'marble') {
    drawMarbleMark(canvas, marbleMarkOf(rec), 1, 1, weight, fill, 0, ARRIVING_NONE, hairline, paints);
  } else {
    drawSpiro(canvas, rec, MARBLE_MARK_REACH_PX, weight, weight * fill, hairline * 0.8, paints);
  }
}

function paintsOf(ink: string): MarkPaints {
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  fill.setColor(Skia.Color(ink));
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setColor(Skia.Color(ink));
  stroke.setStyle(1);
  return { fill, stroke };
}

function recipes(count: number, salt: number): (FaceRecipe & { state: (typeof STATES)[number] })[] {
  const q = mulberry32(7919 + salt);
  return Array.from({ length: count }, (_, i) => ({
    seed: Math.floor(q() * 2 ** 31),
    id: `r${salt}-${i}`,
    model: MODELS[Math.floor(q() * 4)],
    durationMs: 90000 + Math.floor(q() * 300000),
    state: STATES[Math.floor(q() * 3)],
  }));
}

/**
 * One sheet: the four lenses mixed at random on a 12 × 12 field; then each
 * lens alone, 12 × 3, one row per ink (remote, cached, downloaded).
 */
function sheet(bg: string, ink: string): Uint8Array {
  const cols = 12;
  const mixed = 12;
  const alone = LENS_ORDER.length * 3;
  const gap = 1;
  const rows = mixed + gap + alone + LENS_ORDER.length - 1;
  const w = cols * PITCH + PITCH;
  const h = rows * PITCH + PITCH;
  const surface = Skia.Surface.Make(Math.round(w * DENSITY), Math.round(h * DENSITY))!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color(bg));
  canvas.scale(DENSITY, DENSITY);
  const paints = paintsOf(ink);
  const at = (col: number, row: number, draw: () => void) => {
    canvas.save();
    canvas.translate(PITCH + col * PITCH, PITCH + row * PITCH);
    draw();
    canvas.restore();
  };
  const pick = mulberry32(31);
  recipes(cols * mixed, 0).forEach((rec, i) => {
    const lens = LENS_ORDER[Math.floor(pick() * LENS_ORDER.length)];
    at(i % cols, Math.floor(i / cols), () => drawOne(canvas, lens, rec, rec.state, paints));
  });
  let row = mixed + gap;
  LENS_ORDER.forEach((lens, li) => {
    const list = recipes(cols, 100 + li);
    STATES.forEach(state => {
      list.forEach((rec, col) => at(col, row, () => drawOne(canvas, lens, rec, state, paints)));
      row += 1;
    });
    row += 1;
  });
  surface.flush();
  const image = surface.makeImageSnapshot();
  const png = image.encodeToBytes();
  image.dispose();
  surface.dispose();
  return png;
}

/** Mean ink over the mark's own box, per state, for each lens: the page's `inkOrder`. */
export function inkOrder(lens: Lens): number[] {
  const size = Math.ceil(NAME_LENS_KNOBS.MARK_RADIUS_PX * 4.4);
  const dpr = 2;
  const surface = Skia.Surface.Make(size * dpr, size * dpr)!;
  const canvas = surface.getCanvas();
  const paints = paintsOf('black');
  const list = recipes(40, 9);
  return STATES.map(state => {
    let sum = 0;
    for (const rec of list) {
      canvas.clear(Skia.Color('white'));
      canvas.save();
      canvas.scale(dpr, dpr);
      canvas.translate(size / 2, size / 2);
      drawOne(canvas, lens, rec, state, paints);
      canvas.restore();
      surface.flush();
      const image = surface.makeImageSnapshot();
      const px = image.readPixels() as Uint8Array;
      let s = 0;
      for (let i = 0; i < px.length; i += 4) s += 1 - px[i] / 255;
      sum += s / (px.length / 4);
      image.dispose();
    }
    return sum / list.length;
  });
}

describe('the M0 line-up', () => {
  it('draws every lens in every ink, light and dark', () => {
    const light = sheet('#FFFFFF', '#000000');
    const dark = sheet('#000000', '#FFFFFF');
    expect(light.length).toBeGreaterThan(1000);
    const dir = process.env.MARBLE_LINEUP;
    if (dir) {
      const fs = require('fs');
      fs.writeFileSync(`${dir}/marble-lineup-light.png`, light);
      fs.writeFileSync(`${dir}/marble-lineup-dark.png`, dark);
      const orders = LENS_ORDER.map(lens => `${lens}: ${inkOrder(lens).map(v => v.toFixed(3)).join(' < ')}`);
      console.log(orders.join('\n'));
    }
  });
});
