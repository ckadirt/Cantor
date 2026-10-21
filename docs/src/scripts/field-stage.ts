/**
 * The landing's field stage: one canvas, driven by how far the stage has been
 * scrolled. A song's face, large; it flies to its place as the rest of the
 * library arrives from different depths; the inks say where each song is;
 * then every mark changes lens, circle to seal to marbling, as the app's
 * picker does; then the camera falls into the first song.
 *
 * Every shape is the app's geometry (cantor/src/lenses). The scroll is the
 * clock, so nothing here plays on its own except the hero's slow breath.
 */
import { FACE_MAX_EXTENT, faceClockPoints, facePoints, mulberry32 } from '../../../cantor/src/lenses/face';
import { SEAL_FILLED_GROW, SEAL_KNOBS, sealModel } from '../../../cantor/src/lenses/seal';
import {
  applyMarbleOp,
  copySurface,
  marbleIdentityOpsFrom,
  marbleRandom,
  surfaceReach,
  MARBLE_KNOBS,
  type MarbleOp,
  type MarbleSurface,
} from '../../../cantor/src/lenses/marble';
import { stageMap, type StageMark } from '../lib/library';
import { NAME_LENS_SPINDLE_RATIO } from '../lib/marks';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The windows of the story, in stage progress. */
export const BEATS = {
  heroFly: [0.05, 0.2],
  arrive: [0.08, 0.3],
  labels: [0.27, 0.33],
  inks: [0.3, 0.38],
  seal: [0.45, 0.57],
  marble: [0.63, 0.75],
  dive: [0.84, 0.97],
} as const;

type Mark = StageMark & {
  /** Depth: near marks start further out and larger, and arrive later. */
  depth: number;
  from: [number, number];
  arriveAt: number;
  /** The face's contour and the seal's dots, in unit face space. */
  contour: { x: number; y: number }[];
  clock: { x: number; y: number }[];
  dots: { x: number; y: number }[];
  /** The marbling: one landed surface per op count, and its ops. */
  ops: MarbleOp[];
  landed: MarbleSurface[];
  reach: number;
  wave: number;
};

function prepare(m: StageMark, random: () => number, hero: boolean): Mark {
  const depth = 0.25 + random() * 0.75;
  const angle = random() * Math.PI * 2;
  const far = 1.2 + (1 - depth) * 2.4;
  const model = sealModel(m.recipe);
  const level = model.levels[SEAL_KNOBS.MARK_DEPTH];
  const dots = level.x.map((x, i) => ({ x, y: level.y[i] }));
  const ops = marbleIdentityOpsFrom(marbleRandom(m.recipe), MARBLE_KNOBS.MARK_POINTS);
  if (m.recipe.imported) {
    // The imported marker in marbling's own form: a clear drop at the centre.
    ops.push({ kind: 'drop', x: 0, y: 0, r: 0.12, ink: false, points: MARBLE_KNOBS.MARK_POINTS });
  }
  const landed: MarbleSurface[] = [{ rings: [] }];
  for (const op of ops) {
    const next = copySurface(landed[landed.length - 1]);
    applyMarbleOp(next, op, 1);
    landed.push(next);
  }
  return {
    ...m,
    // The song the camera falls into is one you have kept: solid ink.
    ink: hero ? 'downloaded' : m.ink,
    depth,
    from: [Math.cos(angle) * far, Math.sin(angle) * far],
    arriveAt: hero ? 0 : BEATS.arrive[0] + (1 - depth) * 0.08 + random() * 0.07,
    contour: facePoints(m.recipe, 72).map((p) => ({ x: p.x / FACE_MAX_EXTENT, y: p.y / FACE_MAX_EXTENT })),
    clock: faceClockPoints(m.recipe, dots.length).map((p) => ({ x: p.x / FACE_MAX_EXTENT, y: p.y / FACE_MAX_EXTENT })),
    dots,
    ops,
    landed,
    reach: Math.max(0.01, surfaceReach(landed[landed.length - 1])),
    wave: 0,
  };
}

export function startFieldStage(canvas: HTMLCanvasElement, stage: HTMLElement, heroTitle: string, onProgress: (p: number) => void) {
  const ctx = canvas.getContext('2d')!;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let columns = 0;
  let marks: Mark[] = [];
  let hero: Mark | undefined;
  let groups: { label: string; x: number; y: number }[] = [];
  let box = { x: 0, y: 0, w: 1, h: 1 };
  let R = 1;

  const build = () => {
    const wide = innerWidth / innerHeight > 1.15;
    const want = wide ? 4 : 2;
    if (want === columns) return;
    columns = want;
    const map = stageMap(columns);
    const random = mulberry32(0x57a6e);
    marks = map.marks.map((m) => prepare(m, random, m.title === heroTitle));
    hero = marks.find((m) => m.title === heroTitle);
    groups = map.groups;
    box = map.box;
    R = map.markRadius;
    const minX = box.x;
    for (const m of marks) m.wave = (m.x - minX) / box.w;
  };

  const colours = () => {
    const s = getComputedStyle(stage);
    return { ink: s.getPropertyValue('--ink').trim(), faint: s.getPropertyValue('--faint').trim(), muted: s.getPropertyValue('--muted').trim(), paper: s.getPropertyValue('--paper').trim() };
  };

  const progress = () => {
    const r = stage.getBoundingClientRect();
    return clamp(-r.top / Math.max(1, r.height - innerHeight));
  };

  let last = -1;
  let breath = 0;
  const born = performance.now();
  /** The intro: the hero's contour drawing itself, once, on a linear clock. */
  let intro = still ? 1 : 0;
  let pointer: { x: number; y: number } | null = null;
  let named: Mark | null = null;
  const tip = stage.querySelector<HTMLElement>('[data-stage-tip]');
  canvas.parentElement!.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    last = -1;
  });
  canvas.parentElement!.addEventListener('pointerleave', () => {
    pointer = null;
    last = -1;
  });
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const r = stage.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const p = progress();
    intro = still ? 1 : clamp((now - born - 250) / 1500);
    breath = still ? 0 : Math.sin(now / 1600) * 0.012 * (1 - span(p, 0, BEATS.heroFly[0]));
    if (p === last && breath === 0 && intro >= 1) return;
    last = p;
    onProgress(p);
    draw(p);
  };

  const draw = (p: number) => {
    build();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const c = colours();
    ctx.clearRect(0, 0, w, h);

    // The map sits in the right of a wide screen, the bottom of a tall one.
    const wide = columns === 4;
    const area = wide
      ? { x: w * 0.36, y: h * 0.16, w: w * 0.52, h: h * 0.72 }
      : { x: w * 0.06, y: h * 0.47, w: w * 0.88, h: h * 0.48 };
    let scale = Math.min(area.w / (box.w + R * 4), area.h / (box.h + R * 4));
    let ox = area.x + area.w / 2 - (box.x + box.w / 2) * scale;
    let oy = area.y + area.h / 2 - (box.y + box.h / 2) * scale;

    // The dive: the camera falls into the hero until it fills the screen.
    const dive = ease(span(p, ...BEATS.dive));
    if (hero && dive > 0) {
      const target = (Math.min(w, h) * 0.42) / (R * 1.15);
      const z = lerp(scale, target, dive * dive);
      const hx = hero.x * scale + ox;
      const hy = hero.y * scale + oy;
      const cx = lerp(hx, w / 2, dive);
      const cy = lerp(hy, h / 2, dive);
      ox = cx - hero.x * z;
      oy = cy - hero.y * z;
      scale = z;
    }

    const rPx = R * scale;
    const labels = span(p, ...BEATS.labels) * (1 - span(p, BEATS.dive[0], BEATS.dive[0] + 0.04));
    if (labels > 0) {
      ctx.fillStyle = c.muted;
      ctx.globalAlpha = labels;
      ctx.font = `${(wide ? 10 : 9) * dpr}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      for (const g of groups) ctx.fillText(wide ? spaced(g.label) : g.label, g.x * scale + ox, g.y * scale + oy);
      ctx.globalAlpha = 1;
    }

    const inks = span(p, ...BEATS.inks);
    const toSeal = (m: Mark) => ease(span(p, BEATS.seal[0] + m.wave * 0.05, BEATS.seal[1] - 0.05 + m.wave * 0.05));
    const toMarble = (m: Mark) => ease(span(p, BEATS.marble[0] + m.wave * 0.05, BEATS.marble[1] - 0.05 + m.wave * 0.05));
    const others = 1 - span(p, BEATS.dive[0], BEATS.dive[0] + 0.06);

    const seen: { m: Mark; x: number; y: number; r: number }[] = [];
    for (const m of marks) {
      const isHero = m === hero;
      let x = m.x * scale + ox;
      let y = m.y * scale + oy;
      let radius = rPx;
      let alpha = isHero ? 1 : others;

      if (isHero) {
        // From the middle of the screen, large, to its place in the map.
        const fly = ease(span(p, ...BEATS.heroFly));
        const big = Math.min(w, h) * (wide ? 0.3 : 0.26) * (1 + breath);
        const hx = wide ? w * 0.66 : w * 0.5;
        const hy = wide ? h * 0.5 : h * 0.4;
        x = lerp(hx, x, fly);
        y = lerp(hy, y, fly);
        radius = lerp(big, rPx, fly);
      } else {
        const u = span(p, m.arriveAt, m.arriveAt + 0.12);
        if (u <= 0) continue;
        if (!still) {
          const e = ease(u);
          const k = (1 - e) * Math.max(w, h) * 0.45;
          x += m.from[0] * k;
          y += m.from[1] * k;
          radius *= lerp(1 + (1 - m.depth) * 4, 1, e);
        }
        alpha *= Math.min(1, u * 1.6);
      }
      if (alpha <= 0) continue;
      seen.push({ m, x, y, r: radius });

      // Ink: everything arrives as a black outline; then the field says where
      // each song is. Remote fades to grey, kept fills in.
      const kept = m.ink === 'downloaded' || m.recipe.imported === true;
      const inkColour = m.ink === 'remote' && !isHero ? mix(c.ink, c.faint, inks) : c.ink;
      const fill = kept ? inks : 0;
      const sealT = toSeal(m);
      const marbleT = toMarble(m);
      ctx.globalAlpha = alpha;

      if (marbleT > 0) drawMarble(m, x, y, radius, marbleT, inkColour, fill, c.paper);
      if (marbleT < 1 && sealT > 0) drawSeal(m, x, y, radius, sealT, 1 - marbleT, inkColour, kept ? inks : 0);
      if (sealT < 1) drawFace(m, x, y, radius, 1 - Math.min(1, sealT * 1.8), inkColour, fill, isHero ? Math.max(1, radius / 60) : 1, dpr, isHero ? intro : 1);
    }
    ctx.globalAlpha = 1;

    // The song the story follows keeps its name in the map, on a hairline.
    const hs = seen.find((v) => v.m === hero);
    const follow = span(p, BEATS.heroFly[1] - 0.02, BEATS.heroFly[1] + 0.02) * (1 - span(p, BEATS.seal[0] - 0.04, BEATS.seal[0]));
    if (hs && follow > 0) {
      ctx.font = `italic ${15 * dpr}px "CMU Serif", Georgia, serif`;
      const text = `“${hero!.title}”`;
      // The label leans away from the nearer edge, so it never leaves the screen.
      const leftward = hs.x + 46 * dpr + ctx.measureText(text).width > w - 16 * dpr;
      const lx = leftward ? hs.x - 46 * dpr - ctx.measureText(text).width : hs.x + 46 * dpr;
      const ly = hs.y - 38 * dpr;
      ctx.globalAlpha = follow;
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(hs.x + (leftward ? -1 : 1) * hs.r * 1.2, hs.y - hs.r * 1.2);
      ctx.lineTo(leftward ? lx + ctx.measureText(text).width + 6 * dpr : lx - 6 * dpr, ly + 4 * dpr);
      ctx.stroke();
      ctx.fillStyle = c.ink;
      ctx.textAlign = 'left';
      ctx.fillText(text, lx, ly);
      ctx.globalAlpha = 1;
    }

    // Pointing at a song names it, while the map is a map.
    let near: Mark | null = null;
    if (pointer && p > BEATS.labels[0] && p < BEATS.dive[0]) {
      const px = pointer.x * dpr;
      const py = pointer.y * dpr;
      let best = Infinity;
      for (const v of seen) {
        const d = Math.hypot(v.x - px, v.y - py);
        if (d < Math.max(v.r * 1.6, 12 * dpr) && d < best) {
          best = d;
          near = v.m;
        }
      }
    }
    if (near !== named) {
      named = near;
      if (tip) {
        tip.hidden = !near;
        if (near) {
          tip.querySelector('i')!.textContent = `“${near.title}”`;
          tip.querySelector('span')!.textContent = near.recipe.imported
            ? `${near.byline} · your own file`
            : `made with ${near.byline} · ${near.ink === 'remote' ? 'on your node' : near.ink === 'cached' ? 'cached on your phone' : 'kept on your phone'}`;
        }
      }
      canvas.parentElement!.style.cursor = near ? 'pointer' : '';
    }
    if (tip && near && pointer) tip.style.translate = `${pointer.x + 18}px ${pointer.y + 14}px`;
  };

  function drawFace(m: Mark, x: number, y: number, r: number, a: number, ink: string, fill: number, weight: number, dpr: number, drawn = 1) {
    if (a <= 0 || drawn <= 0) return;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a;
    ctx.beginPath();
    // `drawn` < 1 draws only the start of the contour: the pen still moving.
    const n = drawn >= 1 ? m.contour.length : Math.max(2, Math.floor(ease(drawn) * m.contour.length));
    for (let i = 0; i < n; i += 1) {
      const p = m.contour[i];
      if (i) ctx.lineTo(x + p.x * r, y + p.y * r);
      else ctx.moveTo(x + p.x * r, y + p.y * r);
    }
    if (drawn < 1) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = weight * dpr;
      ctx.stroke();
      ctx.globalAlpha = prev;
      return;
    }
    ctx.closePath();
    if (m.recipe.imported) {
      const s = r * NAME_LENS_SPINDLE_RATIO;
      ctx.moveTo(x + s, y);
      ctx.arc(x, y, s, 0, Math.PI * 2, true);
    }
    if (fill > 0) {
      ctx.globalAlpha = prev * a * fill;
      ctx.fillStyle = ink;
      ctx.fill('evenodd');
      ctx.globalAlpha = prev * a;
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = weight * dpr;
    ctx.stroke();
    ctx.globalAlpha = prev;
  }

  function drawSeal(m: Mark, x: number, y: number, r: number, t: number, a: number, ink: string, filled: number) {
    // The app's arrival: each dot leaves the circle where its moment stands
    // on the clock and travels to its place in the seal.
    // The seal's side is SIDE_RATIO of the face's base radius, which is the
    // reach (r) over FACE_MAX_EXTENT: so the seal stands where the face stood.
    const side = (SEAL_KNOBS.SIDE_RATIO * r) / FACE_MAX_EXTENT;
    const cell = side / 3 ** SEAL_KNOBS.MARK_DEPTH;
    const dot = (cell * SEAL_KNOBS.DOT_FILL * lerp(1, SEAL_FILLED_GROW, filled)) / 2;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a;
    ctx.fillStyle = ink;
    ctx.beginPath();
    const n = m.dots.length;
    for (let i = 0; i < n; i += 1) {
      const u = clamp((t - (i / n) * 0.4) / 0.6);
      const from = m.clock[i];
      const to = m.dots[i];
      const px = x + lerp(from.x * r, to.x * side, u);
      const py = y + lerp(from.y * r, to.y * side, u);
      const rr = dot * lerp(0.35, 1, u);
      ctx.moveTo(px + rr, py);
      ctx.arc(px, py, rr, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = prev;
  }

  function drawMarble(m: Mark, x: number, y: number, r: number, t: number, ink: string, fill: number, paper: string) {
    // The drops land one after another, each growing as √fraction, as the
    // app's bath does.
    const n = m.ops.length;
    const at = t * n;
    const k = Math.min(n, Math.floor(at));
    let surface = m.landed[k];
    if (k < n) {
      surface = copySurface(surface);
      applyMarbleOp(surface, m.ops[k], at - k);
    }
    const s = (r * 1.05) / m.reach;
    ctx.beginPath();
    for (const ring of surface.rings) {
      if (!ring.toggle) continue;
      const pts = ring.pts;
      ctx.moveTo(x + pts[0] * s, y + pts[1] * s);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(x + pts[i] * s, y + pts[i + 1] * s);
      ctx.closePath();
    }
    // Kept songs are solid ink; the rest are drawn as the outline of their ink.
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    const prev = ctx.globalAlpha;
    if (fill > 0) {
      ctx.globalAlpha = prev * fill;
      ctx.fill('evenodd');
    }
    ctx.globalAlpha = prev * (1 - fill * 0.85);
    ctx.stroke();
    ctx.globalAlpha = prev;
    void paper;
  }

  addEventListener('resize', () => (last = -1));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (last = -1));
  requestAnimationFrame(frame);
}

function spaced(label: string) {
  return label.split('').join(String.fromCharCode(8202));
}

/** Mix two #rrggbb colours. */
function mix(a: string, b: string, t: number) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  const c = pa.map((v, i) => Math.round(lerp(v, pb[i], t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function parse(hex: string) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
