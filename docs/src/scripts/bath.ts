/**
 * A live marbling bath in a canvas, with the app's own equations
 * (`cantor/src/lenses/marble.ts`). The identity is drawn at once; then bars
 * land one after another, each on its own linear clock, and the view zooms
 * out by the bath's area-equivalent radius, as the app's player does.
 *
 * The bars are a stand-in: the app adds one per bar of the music, and a web
 * page has no music. They come from the same recipe's random stream.
 */
import {
  applyMarbleOp,
  applyMarbleOpRefined,
  copySurface,
  marbleIdentityOpsFrom,
  marbleRandom,
  type MarbleOp,
  type MarbleSurface,
} from '../../../cantor/src/lenses/marble';
import { recipeOf } from '../lib/art';

type BathOptions = {
  /** How many area radii the canvas's half-side spans. */
  fit?: number;
  /** Where the bath's centre sits, as a share of the canvas. */
  cx?: number;
  cy?: number;
  opMs?: number;
  bars?: number;
  onBar?: (bar: number) => void;
};

function opsOf(name: string, bars: number) {
  const random = marbleRandom(recipeOf(name));
  const ops: MarbleOp[] = marbleIdentityOpsFrom(random, 96);
  const identity = ops.length;
  for (let bar = 0; bar < bars; bar += 1) {
    const a = bar * 2.39996 + random() * 0.4;
    const at = 0.15 + random() * 0.45;
    ops.push({
      kind: 'drop',
      x: Math.cos(a) * at,
      y: Math.sin(a) * at,
      r: 0.12 + random() * 0.16,
      ink: bar % 2 === 0,
      points: 96,
    });
    if (bar % 8 === 7) {
      const d = random() * Math.PI * 2;
      ops.push({
        kind: 'tine',
        mx: Math.cos(d),
        my: Math.sin(d),
        off: (random() - 0.5) * 0.5,
        z: 0.22 + random() * 0.2,
        lambda: 0.1 + random() * 0.12,
      });
    }
  }
  return { ops, identity };
}

/** Fill a bath: one even-odd path of the rings whose colour toggles. */
function paint(
  ctx: CanvasRenderingContext2D,
  surface: MarbleSurface,
  cx: number,
  cy: number,
  scale: number,
  colour: string,
) {
  ctx.beginPath();
  for (const ring of surface.rings) {
    if (!ring.toggle) continue;
    const p = ring.pts;
    ctx.moveTo(cx + p[0] * scale, cy + p[1] * scale);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(cx + p[i] * scale, cy + p[i + 1] * scale);
    ctx.closePath();
  }
  ctx.fillStyle = colour;
  ctx.fill('evenodd');
}

export function startBath(canvas: HTMLCanvasElement, name: string, options: BathOptions = {}) {
  const fit = options.fit ?? 1.6;
  const opMs = options.opMs ?? 1000;
  const { ops, identity } = opsOf(name, options.bars ?? 72);
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const surface: MarbleSurface = { rings: [] };
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let area = 0;
  let landed = 0;
  let started = performance.now();
  let view = 0;
  let visible = true;

  const settle = (op: MarbleOp) => {
    if (op.kind === 'drop') area += op.r * op.r;
    // No far radius: the view keeps zooming out, so nothing leaves sight for good.
    applyMarbleOpRefined(surface, op, 0.012 * Math.sqrt(area));
    landed += 1;
  };
  while (landed < identity) settle(ops[landed]);

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) started = performance.now();
  }).observe(canvas);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    let shown = surface;
    let u = 0;
    if (landed < ops.length && !still.matches) {
      u = Math.min(1, (now - started) / opMs);
      if (u >= 1) {
        settle(ops[landed]);
        options.onBar?.(landed - identity);
        started = now;
        u = 0;
      } else {
        shown = copySurface(surface);
        applyMarbleOp(shown, ops[landed], u);
      }
    }
    const next = ops[landed];
    const pending = next && next.kind === 'drop' ? next.r * next.r * u : 0;
    const target = Math.sqrt(area + pending);
    view = view === 0 ? target : view + (target - view) * 0.04;
    const scale = Math.min(w, h) / 2 / (fit * Math.max(view, 0.3));
    ctx.clearRect(0, 0, w, h);
    const ink = getComputedStyle(canvas).color;
    // A portrait canvas (a phone) centres the bath above the words.
    const portrait = h > w;
    const cx = portrait ? 0.5 : options.cx ?? 0.5;
    const cy = portrait ? 0.38 : options.cy ?? 0.5;
    paint(ctx, shown, w * cx, h * cy, scale, ink);
  };
  requestAnimationFrame(frame);
}

/** The identity alone, still, fitted to the canvas: a page's plate. */
export function drawMarbleStill(canvas: HTMLCanvasElement, name: string, fill = 0.9) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { ops } = opsOf(name, 0);
  const surface: MarbleSurface = { rings: [] };
  let area = 0;
  for (const op of ops) {
    if (op.kind === 'drop') area += op.r * op.r;
    applyMarbleOpRefined(surface, op, 0.012 * Math.sqrt(area));
  }
  let reach = 0;
  for (const ring of surface.rings) {
    for (let i = 0; i < ring.pts.length; i += 2) {
      reach = Math.max(reach, Math.hypot(ring.pts[i], ring.pts[i + 1]));
    }
  }
  const draw = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    const scale = (Math.min(canvas.width, canvas.height) / 2 / reach) * fill;
    paint(ctx, copySurface(surface), canvas.width / 2, canvas.height / 2, scale, getComputedStyle(canvas).color);
  };
  draw();
  new ResizeObserver(draw).observe(canvas);
  // The ink follows the theme, so repaint when it changes.
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
}
