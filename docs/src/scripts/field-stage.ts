/**
 * The landing's field stage: one canvas. The library floats round the page
 * while one song's shape stands large, morphing from song to song; the
 * floating songs gather into the map, which then plays on its own —
 * regathering by month, playlist and artist, changing lens, its inks filling
 * as songs come down — until the next section slides up over it.
 *
 * Every shape is the app's geometry (cantor/src/lenses). The scroll only says
 * which scene is showing; everything inside a scene plays on time, so the
 * page can be scrolled on at any moment.
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
import { sampleLibrary, stageMap, type SampleSong, type StageAxis, type StageGroup } from '../lib/library';
import { NAME_LENS_SPINDLE_RATIO } from '../lib/marks';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * How much scroll each scene is given, in screen heights. Inside a scene the
 * motion runs on time, so a scene only needs room to be read in. The last,
 * `cover`, is the screen's worth in which the next section slides up over
 * the map (the page overlaps the two by a screen).
 */
const SCENES_VH = { hero: 25, shape: 90, map: 90, cover: 100 } as const;
/** The stage's scroll run: its height is this plus the screen it is pinned in. */
export const FIELD_RUN_VH = Object.values(SCENES_VH).reduce((a, b) => a + b, 0);
const at = (vh: number) => vh / FIELD_RUN_VH;

/** The windows of the story, in stage progress. */
export const BEATS = {
  /** The first beat's words arrive (a phone moves the shape down for them). */
  shape: at(SCENES_VH.hero),
  /** From here the library is a map; before it, it floats. */
  gather: at(SCENES_VH.hero + SCENES_VH.shape),
  /** From here the next section covers the map. */
  cover: at(SCENES_VH.hero + SCENES_VH.shape + SCENES_VH.map),
} as const;

/** The songs the large shape morphs through; the first is the one the story follows. */
export const SPECIMENS = [
  'an empty ballroom',
  'rain on a tin roof',
  'cumbia under the bridge',
  'a lullaby in D',
  'two guitars arguing',
] as const;
const SPECIMEN_HOLD_MS = 2600;
const MORPH_MS = 1100;
const GATHER_MS = 1900;

/**
 * Where the large shape stands, as fractions of the stage: `y` beside the
 * title, `then` once the words of the first beat arrive (a phone has no room
 * beside them). The page's CSS seats the specimen's caption from the same
 * numbers (`.specimen`).
 */
export const HERO_AT = {
  wide: { x: 0.585, y: 0.37, then: 0.39, r: 0.25 },
  tall: { x: 0.5, y: 0.25, then: 0.55, r: 0.25 },
} as const;

export const AXES: readonly StageAxis[] = ['month', 'playlist', 'artist'];
export const LENSES = ['circle', 'seal', 'marbling'] as const;
/** The map's own tour: [axis, lens] pairs, each a step its inks can fill on. */
const TOUR: readonly (readonly [number, number])[] = [
  [0, 0], [0, 1], [1, 1], [1, 2], [2, 2], [2, 0], [1, 0],
];
const HOLD_MS = 3400;
const MOVE_MS = 1500;

export type Mode = { axis: number; lens: number; step: number };

type Mark = SampleSong & {
  hero: boolean;
  /** Where it floats before the map gathers, in screen pixels, and its size there. */
  idle: { x: number; y: number; r: number };
  phase: number;
  delay: number;
  /** Its place on each axis, in that axis's world units. */
  pos: Record<StageAxis, { x: number; y: number }>;
  /** 0 on the node, 1 cached, 2 kept; and the tour step it comes down on, if any. */
  level: number;
  fillsAt: number;
  wave: number;
  contour: { x: number; y: number }[];
  ring: { x: number; y: number }[];
  clock: { x: number; y: number }[];
  dots: { x: number; y: number }[];
  ops: MarbleOp[];
  landed: MarbleSurface[];
  reach: number;
};

type Axis = { groups: StageGroup[]; box: { x: number; y: number; w: number; h: number }; R: number };

const RING = 120;
const unit = (pts: readonly { x: number; y: number }[]) => pts.map((p) => ({ x: p.x / FACE_MAX_EXTENT, y: p.y / FACE_MAX_EXTENT }));

function prepare(song: SampleSong, random: () => number, hero: boolean): Mark {
  const model = sealModel(song.recipe);
  const level = model.levels[SEAL_KNOBS.MARK_DEPTH];
  const dots = level.x.map((x, i) => ({ x, y: level.y[i] }));
  const ops = marbleIdentityOpsFrom(marbleRandom(song.recipe), MARBLE_KNOBS.MARK_POINTS);
  if (song.recipe.imported) {
    // The imported marker in marbling's own form: a clear drop at the centre.
    ops.push({ kind: 'drop', x: 0, y: 0, r: 0.12, ink: false, points: MARBLE_KNOBS.MARK_POINTS });
  }
  const landed: MarbleSurface[] = [{ rings: [] }];
  for (const op of ops) {
    const next = copySurface(landed[landed.length - 1]);
    applyMarbleOp(next, op, 1);
    landed.push(next);
  }
  const base = song.recipe.imported || hero ? 2 : song.ink === 'remote' ? 0 : song.ink === 'cached' ? 1 : 2;
  return {
    ...song,
    hero,
    idle: { x: 0, y: 0, r: 0 },
    phase: random() * Math.PI * 2,
    delay: random() * 0.45,
    pos: { month: { x: 0, y: 0 }, playlist: { x: 0, y: 0 }, artist: { x: 0, y: 0 } },
    level: base,
    // About a third of what is not kept comes down while the map plays.
    fillsAt: base < 2 && random() < 0.4 ? 1 + Math.floor(random() * (TOUR.length - 1)) : -1,
    wave: 0,
    contour: unit(facePoints(song.recipe, 72)),
    ring: unit(faceClockPoints(song.recipe, RING)),
    clock: unit(faceClockPoints(song.recipe, dots.length)),
    dots,
    ops,
    landed,
    reach: Math.max(0.01, surfaceReach(landed[landed.length - 1])),
  };
}

export type FieldStage = { setAxis(axis: number): void; setLens(lens: number): void; setSpecimen(index: number): void };
/** The large shape: the specimen it is becoming, the one it leaves, and how far between. */
export type Specimen = { index: number; from: number; t: number };

export function startFieldStage(
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  heroTitle: string,
  onProgress: (p: number) => void,
  onMode: (mode: Mode) => void,
  onSpecimen: (specimen: Specimen) => void,
): FieldStage {
  const ctx = canvas.getContext('2d')!;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const songs = sampleLibrary();
  const random = mulberry32(0x57a6e);
  const marks = songs.map((s) => prepare(s, random, s.title === heroTitle));
  const hero = marks.find((m) => m.hero)!;
  const specimens = SPECIMENS.map((title) => unit(faceClockPoints(songs.find((s) => s.title === title)!.recipe, RING)));
  const axes = {} as Record<StageAxis, Axis>;
  let built = '';

  /** Seat every axis for this screen: as many columns as fill the map's area best. */
  const build = (w: number, h: number, area: { w: number; h: number }, wide: boolean, dpr: number) => {
    const key = `${w}x${h}`;
    if (key === built) return;
    built = key;
    for (const axis of AXES) {
      let best: { map: ReturnType<typeof stageMap>; fit: number } | null = null;
      for (const columns of wide ? [3, 4, 5] : [2, 3]) {
        const map = stageMap(columns, axis, songs);
        const fit = Math.min(area.w / (map.box.w + map.markRadius * 4), area.h / (map.box.h + map.markRadius * 4));
        if (!best || fit > best.fit) best = { map, fit };
      }
      const map = best!.map;
      axes[axis] = { groups: map.groups, box: map.box, R: map.markRadius };
      for (const m of map.marks) {
        const mark = marks.find((k) => k.entity.key === m.entity.key);
        if (mark) mark.pos[axis] = { x: m.x, y: m.y };
      }
      if (axis === 'month') for (const m of marks) m.wave = (m.pos.month.x - map.box.x) / map.box.w;
    }
    // Where the library floats before it gathers: anywhere the words and the
    // large shape are not.
    const at = wide ? HERO_AT.wide : HERO_AT.tall;
    const hx = w * at.x;
    const hy = h * at.then;
    const hr = Math.min(w, h) * at.r;
    const keepOut = wide
      ? [
          [0, 0.46, 0.52, 1],
          [0, 0, 1, 0.1],
          [0.88, 0.3, 1, 0.7],
          [0.44, 0.68, 0.82, 1],
          [0, 0.22, 0.34, 0.78],
        ]
      : [
          [0, 0.72, 1, 1],
          [0, 0, 1, 0.34],
          [0.05, 0.8, 0.95, 0.92],
        ];
    const free = (x: number, y: number) =>
      Math.hypot(x - hx, y - hy) > hr * 1.25 &&
      !keepOut.some(([a, b, c, d]) => x > a * w && x < c * w && y > b * h && y < d * h);
    const place = mulberry32(0x1d1e);
    for (const m of marks) {
      if (m.hero) continue;
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 60; tries += 1) {
        x = place() * w;
        y = place() * h;
        if (free(x, y)) break;
      }
      m.idle = { x, y, r: (wide ? 5 : 3.5) * dpr * (0.6 + place() * 1.1) };
    }
  };

  const colours = () => {
    const s = getComputedStyle(stage);
    return { ink: s.getPropertyValue('--ink').trim(), faint: s.getPropertyValue('--faint').trim(), muted: s.getPropertyValue('--muted').trim() };
  };

  const progress = () => {
    const r = stage.getBoundingClientRect();
    return clamp(-r.top / Math.max(1, r.height - innerHeight));
  };

  // ---- the map's own play
  let tour = 0;
  let mode: Mode = { axis: 0, lens: 0, step: 0 };
  let was: Mode = mode;
  let movedAt = -Infinity;
  let pausedUntil = 0;
  let queued: Mode | null = null;
  const go = (next: Mode, now: number) => {
    if (next.axis === mode.axis && next.lens === mode.lens && next.step === mode.step) return;
    if (now - movedAt < MOVE_MS * 1.35 && !still) {
      queued = next;
      return;
    }
    was = mode;
    mode = next;
    movedAt = still ? -Infinity : now;
    onMode(mode);
  };

  // ---- the large shape's own play, and the gathering
  let specimen = { index: 0, from: 0, at: -Infinity };
  let specimenPausedUntil = 0;
  const become = (index: number, now: number) => {
    if (index === specimen.index) return;
    // A morph cut short leaves from the song it was becoming.
    specimen = { index, from: specimen.index, at: still ? -Infinity : now };
  };
  /** 0 floating, 1 a map; it runs on its own clock towards where the scroll is. */
  let gathered = 0;
  let lastNow = performance.now();

  let born = performance.now();
  let pointer: { x: number; y: number } | null = null;
  let named: Mark | null = null;
  const tip = stage.querySelector<HTMLElement>('[data-stage-tip]');
  canvas.parentElement!.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  canvas.parentElement!.addEventListener('pointerleave', () => (pointer = null));

  let lastP = -1;
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const r = stage.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) {
      born = Math.min(born, now - 2000);
      return;
    }
    const p = progress();
    if (p !== lastP) onProgress(p);
    lastP = p;
    const dt = Math.min(100, now - lastNow);
    lastNow = now;
    const mapped = p >= BEATS.gather;
    gathered = still ? Number(mapped) : clamp(gathered + (mapped ? dt : -dt) / GATHER_MS);

    // The shape turns from song to song while it stands alone, and comes home
    // to the one the story follows when the map gathers.
    if (mapped || gathered > 0) become(0, now);
    else if (!still && now > specimenPausedUntil && now - born > 2400 && now - specimen.at > SPECIMEN_HOLD_MS) {
      become((specimen.index + 1) % SPECIMENS.length, now);
    }
    onSpecimen({ index: specimen.index, from: specimen.from, t: ease(clamp((now - specimen.at) / MORPH_MS)) });

    // The tour runs while the map is the map; before it, the map rests on its
    // first step.
    if (queued && now - movedAt >= MOVE_MS * 1.35) {
      const q = queued;
      queued = null;
      go(q, now);
    }
    if (!mapped || gathered < 1) {
      tour = 0;
      if (mode.axis || mode.lens || mode.step) go({ axis: 0, lens: 0, step: 0 }, now);
    } else if (!still && now > pausedUntil && now - movedAt > HOLD_MS) {
      tour = (tour + 1) % TOUR.length;
      go({ axis: TOUR[tour][0], lens: TOUR[tour][1], step: tour }, now);
    }
    draw(p, now);
  };

  const draw = (p: number, now: number) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const wide = w / h > 1.15;
    // The map sits in the right of a wide screen, the bottom of a tall one.
    const area = wide
      ? { x: w * 0.38, y: h * 0.13, w: w * 0.5, h: h * 0.76 }
      : { x: w * 0.04, y: h * 0.44, w: w * 0.92, h: h * 0.5 };
    build(w, h, area, wide, dpr);
    const c = colours();
    ctx.clearRect(0, 0, w, h);

    const fit = (axis: StageAxis) => {
      const a = axes[axis];
      const scale = Math.min(area.w / (a.box.w + a.R * 4), area.h / (a.box.h + a.R * 4));
      return {
        scale,
        ox: area.x + area.w / 2 - (a.box.x + a.box.w / 2) * scale,
        oy: area.y + area.h / 2 - (a.box.y + a.box.h / 2) * scale,
        r: a.R * scale,
      };
    };
    const from = AXES[was.axis];
    const to = AXES[mode.axis];
    const fFrom = fit(from);
    const fTo = fit(to);
    const moved = clamp((now - movedAt) / MOVE_MS);
    /** Each mark leaves in a wave across the map, as the app's re-cut does. */
    const moveOf = (m: Mark) => ease(clamp((moved - m.wave * 0.3) / 0.7));
    const placed = (m: Mark) => {
      const t = moveOf(m);
      const ax = m.pos[from].x * fFrom.scale + fFrom.ox;
      const ay = m.pos[from].y * fFrom.scale + fFrom.oy;
      const bx = m.pos[to].x * fTo.scale + fTo.ox;
      const by = m.pos[to].y * fTo.scale + fTo.oy;
      // A little arc, so a regathering reads as travel rather than a slide.
      const bend = Math.sin(Math.PI * t) * 0.12 * (Math.cos(m.phase) > 0 ? 1 : -1);
      return { x: lerp(ax, bx, t) - (by - ay) * bend, y: lerp(ay, by, t) + (bx - ax) * bend, r: lerp(fFrom.r, fTo.r, t), t };
    };

    const at = wide ? HERO_AT.wide : HERO_AT.tall;
    const intro = still ? 1 : clamp((now - born - 250) / 1500);
    const breath = still ? 0 : Math.sin(now / 1600) * 0.012 * (1 - gathered);
    const gather = gathered;
    const morph = ease(clamp((now - specimen.at) / MORPH_MS));


    // Group names, crossfading between the axes as the map regathers.
    const labels = clamp((gather - 0.5) / 0.5);
    if (labels > 0) {
      ctx.fillStyle = c.muted;
      ctx.font = `${(wide ? 10 : 9) * dpr}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      const fade = ease(moved);
      const sets: [StageAxis, ReturnType<typeof fit>, number][] =
        from === to ? [[to, fTo, 1]] : [[from, fFrom, 1 - fade], [to, fTo, fade]];
      for (const [axis, f, a] of sets) {
        if (a <= 0) continue;
        ctx.globalAlpha = labels * a;
        for (const g of axes[axis].groups) {
          ctx.fillText(spaced(g.label.toUpperCase()), g.x * f.scale + f.ox, g.y * f.scale + f.oy);
        }
      }
      ctx.globalAlpha = 1;
    }

    const levelAt = (m: Mark, step: number) => (m.fillsAt > 0 && step >= m.fillsAt ? Math.min(2, m.level + 1) : m.level);
    const seen: { m: Mark; x: number; y: number; r: number }[] = [];

    for (const m of marks) {
      const q = placed(m);
      let x: number;
      let y: number;
      let radius: number;
      let alpha = 1;
      let level = lerp(levelAt(m, was.step), levelAt(m, mode.step), q.t);
      let contour = m.contour;
      let lensFrom = was.lens;
      let lensTo = mode.lens;
      let lensT = q.t;

      if (m.hero) {
        // Large, beside the title; then it flies to its place in the map.
        const fly = ease(gather);
        const big = Math.min(w, h) * at.r * (1 + breath);
        x = lerp(w * at.x, q.x, fly);
        y = lerp(h * lerp(at.y, at.then, ease(span(p, 0.015, BEATS.shape))), q.y, fly);
        radius = lerp(big, q.r, fly);
        level = lerp(1, level, fly);
        if (gather < 1 || specimen.index !== 0 || morph < 1) {
          const a = specimens[specimen.from];
          const b = specimens[specimen.index];
          contour = a.map((pa, k) => ({ x: lerp(pa.x, b[k].x, morph), y: lerp(pa.y, b[k].y, morph) }));
        }
      } else {
        // Floating, faint and small; gathered, in its place and its ink.
        const u = still ? gather : ease(clamp((gather - m.delay) / 0.55));
        if (u <= 0) {
          const d = still ? 0 : 1;
          x = m.idle.x + Math.sin(now / 2600 + m.phase) * 7 * dpr * d;
          y = m.idle.y + Math.cos(now / 3100 + m.phase * 1.3) * 7 * dpr * d;
          radius = m.idle.r;
          level = 0;
          alpha *= 0.75 * clamp((now - born - 900) / 1200);
        } else {
          const ix = m.idle.x + Math.sin(now / 2600 + m.phase) * 7 * dpr;
          const iy = m.idle.y + Math.cos(now / 3100 + m.phase * 1.3) * 7 * dpr;
          x = lerp(ix, q.x, u);
          y = lerp(iy, q.y, u);
          radius = lerp(m.idle.r, q.r, u);
          level *= u;
          alpha *= lerp(0.75, 1, u);
        }
      }
      if (gather < 1) {
        lensFrom = 0;
        lensTo = 0;
        lensT = 1;
      }
      if (alpha <= 0) continue;
      const v = { x, y, r: radius };
      seen.push({ m, ...v });

      // The ink says where a song is: grey on the node, ink once cached,
      // solid once kept.
      const colour = mix(c.faint, c.ink, clamp(level));
      const fill = clamp(level - 1);
      const weight = m.hero ? Math.max(1, v.r / (60 * dpr)) * dpr : dpr;
      const draw = (lens: number, amount: number, a: number) => {
        if (a <= 0.001) return;
        ctx.globalAlpha = alpha * a;
        if (lens === 0) drawFace(m, v.x, v.y, v.r, colour, fill, weight, contour, m.hero ? intro * amount : amount);
        else if (lens === 1) drawSeal(m, v.x, v.y, v.r, amount, colour, fill);
        else drawMarble(m, v.x, v.y, v.r, amount, colour, fill);
      };
      if (lensFrom === lensTo || lensT >= 1) draw(lensTo, 1, 1);
      else {
        draw(lensFrom, 1, 1 - lensT);
        draw(lensTo, lensT, Math.min(1, lensT * 2.5));
      }
    }
    ctx.globalAlpha = 1;

    // Pointing at a song names it, while the map is a map.
    let near: Mark | null = null;
    if (pointer && gather >= 1 && p < BEATS.cover) {
      const px = pointer.x * dpr;
      const py = pointer.y * dpr;
      let best = Infinity;
      for (const s of seen) {
        const d = Math.hypot(s.x - px, s.y - py);
        if (d < Math.max(s.r * 1.6, 12 * dpr) && d < best) {
          best = d;
          near = s.m;
        }
      }
    }
    if (near !== named) {
      named = near;
      if (tip) {
        tip.hidden = !near;
        if (near) {
          const lvl = levelAt(near, mode.step);
          tip.querySelector('i')!.textContent = `“${near.title}”`;
          tip.querySelector('span')!.textContent = near.recipe.imported
            ? `${near.byline} · your own file`
            : `made with ${near.byline} · ${lvl === 0 ? 'on your computer' : lvl === 1 ? 'cached on your phone' : 'kept on your phone'}`;
        }
      }
      canvas.parentElement!.style.cursor = near ? 'pointer' : '';
    }
    if (tip && near && pointer) tip.style.translate = `${pointer.x + 18}px ${pointer.y + 14}px`;
  };

  function drawFace(m: Mark, x: number, y: number, r: number, ink: string, fill: number, weight: number, contour: { x: number; y: number }[], drawn: number) {
    if (drawn <= 0) return;
    ctx.beginPath();
    // `drawn` < 1 draws only the start of the contour: the pen still moving.
    const n = drawn >= 1 ? contour.length : Math.max(2, Math.floor(ease(drawn) * contour.length));
    for (let i = 0; i < n; i += 1) {
      const p = contour[i];
      if (i) ctx.lineTo(x + p.x * r, y + p.y * r);
      else ctx.moveTo(x + p.x * r, y + p.y * r);
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = weight;
    if (drawn < 1) {
      ctx.stroke();
      return;
    }
    ctx.closePath();
    if (m.recipe.imported) {
      const s = r * NAME_LENS_SPINDLE_RATIO;
      ctx.moveTo(x + s, y);
      ctx.arc(x, y, s, 0, Math.PI * 2, true);
    }
    if (fill > 0) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * fill;
      ctx.fillStyle = ink;
      ctx.fill('evenodd');
      ctx.globalAlpha = prev;
    }
    ctx.stroke();
  }

  function drawSeal(m: Mark, x: number, y: number, r: number, t: number, ink: string, filled: number) {
    // The app's arrival: each dot leaves the circle where its moment stands
    // on the clock and travels to its place in the seal. The seal's side is
    // SIDE_RATIO of the face's base radius, so it stands where the face stood.
    const side = (SEAL_KNOBS.SIDE_RATIO * r) / FACE_MAX_EXTENT;
    const cell = side / 3 ** SEAL_KNOBS.MARK_DEPTH;
    const dot = (cell * SEAL_KNOBS.DOT_FILL * lerp(1, SEAL_FILLED_GROW, filled)) / 2;
    ctx.fillStyle = ink;
    ctx.beginPath();
    const n = m.dots.length;
    for (let i = 0; i < n; i += 1) {
      const u = ease(clamp((t - (i / n) * 0.4) / 0.6));
      const a = m.clock[i];
      const b = m.dots[i];
      const px = x + lerp(a.x * r, b.x * side, u);
      const py = y + lerp(a.y * r, b.y * side, u);
      const rr = dot * lerp(0.35, 1, u);
      ctx.moveTo(px + rr, py);
      ctx.arc(px, py, rr, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function drawMarble(m: Mark, x: number, y: number, r: number, t: number, ink: string, fill: number) {
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
  }

  addEventListener('resize', () => (built = ''));
  requestAnimationFrame(frame);
  onMode(mode);

  const pick = (next: Mode) => {
    pausedUntil = performance.now() + 9000;
    go(next, performance.now());
  };
  return {
    setAxis: (axis) => pick({ ...mode, axis }),
    setLens: (lens) => pick({ ...mode, lens }),
    setSpecimen: (index) => {
      specimenPausedUntil = performance.now() + 9000;
      become(index, performance.now());
    },
  };
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
