/**
 * The source section's demonstration: the app's own contour function beside
 * the shape it draws, traced point by point as the angle sweeps round, the
 * values it computes written beside the lines that compute them. It turns
 * through the songs the page opened with, on its own clock, while in view.
 */
import { FACE_MAX_EXTENT, faceClockPoints, faceParams, type FaceParams } from '../../../cantor/src/lenses/face';
import { sampleLibrary } from '../lib/library';
import { SPECIMENS } from './field-stage';

const TRACE_MS = 4600;
const HOLD_MS = 1800;
const FADE_MS = 500;
const SAMPLES = 360;

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function startSourceStage(section: HTMLElement) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = section.querySelector<HTMLCanvasElement>('[data-trace] canvas')!;
  const ctx = canvas.getContext('2d')!;
  const title = section.querySelector<HTMLElement>('[data-trace-title]')!;
  const notes = new Map([...section.querySelectorAll<HTMLElement>('[data-note]')].map((el) => [el.dataset.note!, el]));
  const songs = sampleLibrary();
  const specimens = SPECIMENS.map((name) => {
    const recipe = songs.find((s) => s.title === name)!.recipe;
    return { name, params: faceParams(recipe), points: faceClockPoints(recipe, SAMPLES) };
  });

  let shownAt: number | null = null;
  let current = -1;
  const say = (key: string, text: string) => {
    const el = notes.get(key);
    if (el && el.textContent !== text) el.textContent = text;
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const r = section.getBoundingClientRect();
    const visible = r.top < innerHeight * 0.85 && r.bottom > innerHeight * 0.15;
    if (!visible) {
      shownAt = null;
      return;
    }
    if (shownAt === null) shownAt = now;
    const cycle = TRACE_MS + HOLD_MS;
    const elapsed = still ? TRACE_MS : now - shownAt;
    const index = Math.floor(elapsed / cycle) % specimens.length;
    const within = still ? TRACE_MS : elapsed % cycle;
    const s = specimens[index];
    if (index !== current) {
      current = index;
      title.textContent = `“${s.name}”`;
      say('params', `// ${s.params.lobes}, ${s.params.detail}, ${s.params.primary.toFixed(3)}, ${s.params.secondary.toFixed(3)}, ${s.params.eccentricity.toFixed(3)}`);
    }
    const traced = ease(clamp(within / TRACE_MS));
    const fade = 1 - clamp((within - (cycle - FADE_MS)) / FADE_MS);
    const k = Math.min(SAMPLES - 1, Math.floor(traced * SAMPLES));
    const angle = ((k + 0.5) / SAMPLES) * Math.PI * 2 - Math.PI / 2;
    const p = s.points[k];
    say('angle', `// angle = ${angle.toFixed(2)}`);
    say('radius', `// = ${radiusOf(p, s.params).toFixed(3)}`);
    say('x', `// ${p.x.toFixed(3)}`);
    say('y', `// ${p.y.toFixed(3)}`);
    draw(s.points, k, traced, fade);
  };

  const draw = (points: readonly { x: number; y: number }[], k: number, traced: number, fade: number) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    const st = getComputedStyle(canvas);
    const ink = st.getPropertyValue('--ink').trim();
    const faint = st.getPropertyValue('--faint').trim();
    const muted = st.getPropertyValue('--muted').trim();
    const cx = w / 2;
    const cy = h / 2;
    const unit = (Math.min(w, h) * 0.42) / FACE_MAX_EXTENT;

    // The page it is drawn on: the axes, and the circle a radius of 1 would make.
    ctx.strokeStyle = faint;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(cx - unit * 1.35, cy);
    ctx.lineTo(cx + unit * 1.35, cy);
    ctx.moveTo(cx, cy - unit * 1.35);
    ctx.lineTo(cx, cy + unit * 1.35);
    ctx.stroke();
    ctx.setLineDash([2 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.arc(cx, cy, unit, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalAlpha = fade;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= k; i += 1) {
      const q = points[i];
      if (i) ctx.lineTo(cx + q.x * unit, cy + q.y * unit);
      else ctx.moveTo(cx + q.x * unit, cy + q.y * unit);
    }
    if (traced >= 1) ctx.closePath();
    ctx.stroke();

    // The hand: from the centre to where this angle lands.
    if (traced < 1) {
      const q = points[k];
      ctx.strokeStyle = muted;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + q.x * unit, cy + q.y * unit);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(cx + q.x * unit, cy + q.y * unit, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  requestAnimationFrame(frame);
}

/** The radius a point was drawn at, read back from the point: the contour divides it by the eccentricity on one axis and multiplies on the other. */
function radiusOf(p: { x: number; y: number }, params: FaceParams) {
  return Math.hypot(p.x / params.eccentricity, p.y * params.eccentricity);
}
