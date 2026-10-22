/**
 * The landing's privacy stage, in ink. First the twelve words a phone makes
 * for itself, revealed as the app reveals them (`IdentityPanel.tsx`): every
 * word written on as the 11 bits it encodes, then each bit string morphing
 * into its word. Then the wire: a phone, the relay and a node, the traffic
 * between them sealed the whole way, and the household one node can serve.
 *
 * The scroll says which scene is showing; inside it everything runs on time.
 */
import { writePhase, writeSubAlpha } from '../../../cantor/src/motion/text';
import type { PhraseSlot } from '../lib/phrase';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
/** The motion engine's one easing: manim's smooth, 10t³ − 15t⁴ + 6t⁵ (`motion/geometry.ts`). */
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * How much scroll each scene is given, in screen heights: about a screen
 * each, since everything inside a scene plays on time.
 */
const SCENES_VH = { words: 85, sealed: 95, household: 80, roaming: 80 } as const;
/** The stage's scroll run: its height is this plus the screen it is pinned in. */
export const PRIVACY_RUN_VH = Object.values(SCENES_VH).reduce((a, b) => a + b, 0);
const at = (vh: number) => vh / PRIVACY_RUN_VH;

/** The windows of the stage, in its progress. */
export const PRIVACY = {
  words: [0, at(SCENES_VH.words)],
  /** The wire holds to the end of the stage: past 1, so it never lifts out while pinned. */
  wire: [at(SCENES_VH.words), 1.01],
  household: at(SCENES_VH.words + SCENES_VH.sealed),
  roaming: at(SCENES_VH.words + SCENES_VH.sealed + SCENES_VH.household),
} as const;

/** The prompt's trip, once the wire is on screen: typed, sealed across the relay, read. */
const TRIP = { TYPE_MS: [300, 1900], CROSS_MS: [1500, 2900], READ_MS: [2600, 4200] } as const;

/** The reveal's clock, as the app's identity panel keeps it (`IdentityPanel.tsx`). */
const REVEAL = {
  PREPARE_MS: 350,
  BITS_WRITE_MS: 800,
  BITS_HOLD_MS: 180,
  MORPH_STAGGER_MS: 100,
  MORPH_MS: 480,
} as const;
const COLUMNS = 3;

const HEX = '0123456789abcdef';

export function startPrivacyStage(stage: HTMLElement, progress: () => number) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the twelve words
  const phrase = stage.querySelector<HTMLElement>('[data-phrase]')!;
  const slots = JSON.parse(phrase.querySelector('script')!.textContent!) as PhraseSlot[];
  const words = phrase.querySelector<HTMLCanvasElement>('canvas')!;
  const wctx = words.getContext('2d')!;
  /** When the reveal began; null until the words are on screen. */
  let revealedAt: number | null = null;
  /** When the wire came on screen, for the prompt's trip; null while it is not. */
  let wiredAt: number | null = null;

  // ---- the wire
  const figure = stage.querySelector<HTMLElement>('[data-wire]')!;
  const canvas = figure.querySelector<HTMLCanvasElement>('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const ends = new Map([...figure.querySelectorAll<HTMLElement>('[data-end]')].map((el) => [el.dataset.end!, el]));
  const links = JSON.parse(figure.dataset.links ?? '[]') as [string, string, number][];
  const plain = figure.querySelector<HTMLElement>('[data-plain]')!;
  const sealed = figure.querySelector<HTMLElement>('[data-sealed]')!;
  const read = figure.querySelector<HTMLElement>('[data-read]')!;
  const prompt = plain.dataset.plain!;
  const cipher = [...prompt].map((ch, i) => (ch === ' ' ? ' ' : HEX[(i * 7 + ch.charCodeAt(0) * 13) % 16])).join('');

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const r = stage.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) {
      revealedAt = null;
      wiredAt = null;
      return;
    }
    const p = progress();
    // The reveal plays once the words are on screen, and again each time they return.
    const showing = p < PRIVACY.words[1] && r.top < innerHeight * 0.4;
    if (!showing) revealedAt = null;
    else if (revealedAt === null) revealedAt = now;
    if (p < PRIVACY.words[1] + 0.02) drawWords(revealedAt === null ? 0 : now - revealedAt);
    // The prompt makes its trip each time the wire comes into view.
    if (p < PRIVACY.wire[0]) wiredAt = null;
    else if (wiredAt === null) wiredAt = now;
    trip(p, still ? Infinity : wiredAt === null ? 0 : now - wiredAt);
    drawWire(p, now);
  };

  const drawWords = (ms: number) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(words.clientWidth * dpr);
    const h = Math.round(words.clientHeight * dpr);
    if (words.width !== w) words.width = w;
    if (words.height !== h) words.height = h;
    wctx.clearRect(0, 0, w, h);
    const s = getComputedStyle(phrase);
    const ink = s.getPropertyValue('--ink').trim();
    const faint = s.getPropertyValue('--faint').trim();

    // A stable grid: the widest bit string fills its column, and neither the
    // bits nor the words ever move a slot.
    const gap = 18 * dpr;
    const number = 30 * dpr;
    const column = (w - gap * (COLUMNS - 1)) / COLUMNS;
    const rows = Math.ceil(slots.length / COLUMNS);
    const widest = Math.max(...slots.map((slot) => Math.max(slot.bitsWidth, slot.wordWidth)));
    const em = Math.min((column - number) / widest, h / rows / 1.7);
    const row = h / rows;
    const t = still ? Infinity : ms - REVEAL.PREPARE_MS;

    slots.forEach((slot, k) => {
      const x = (k % COLUMNS) * (column + gap);
      const base = Math.floor(k / COLUMNS) * row + row / 2 + em * 0.34;
      const ox = x + number;
      wctx.fillStyle = faint;
      wctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
      wctx.textAlign = 'left';
      wctx.fillText(String(k + 1).padStart(2, '0'), x, base);
      const at = (pts: number[], i: number) => [ox + pts[i] * em, base + pts[i + 1] * em];

      const start = REVEAL.BITS_WRITE_MS + REVEAL.BITS_HOLD_MS + k * REVEAL.MORPH_STAGGER_MS;
      const morph = smoother(clamp((t - start) / REVEAL.MORPH_MS));
      if (morph <= 0) {
        // The bits write themselves on: each glyph's border, then its fill,
        // on the app's Write clock (`motion/text.ts`).
        const write = clamp(t / REVEAL.BITS_WRITE_MS);
        if (write <= 0) return;
        for (let g = 0; g < slot.glyphs; g += 1) {
          const phase = writePhase(writeSubAlpha(write, g, slot.glyphs));
          const contours = slot.from.filter((_, c) => slot.fromGlyph[c] === g);
          wctx.strokeStyle = ink;
          wctx.lineWidth = dpr;
          wctx.globalAlpha = phase.borderAlpha;
          for (const pts of contours) {
            const n = pts.length / 2;
            const end = Math.round(phase.borderEnd * n);
            if (end < 2) continue;
            wctx.beginPath();
            for (let i = 0; i < end; i += 1) {
              const [px, py] = at(pts, i * 2);
              if (i) wctx.lineTo(px, py);
              else wctx.moveTo(px, py);
            }
            if (end >= n) wctx.closePath();
            wctx.stroke();
          }
          if (phase.fillAlpha > 0) {
            // One path per glyph, so its counters stay open.
            wctx.beginPath();
            for (const pts of contours) trace(pts, at);
            wctx.globalAlpha = phase.fillAlpha;
            wctx.fillStyle = ink;
            wctx.fill('nonzero');
          }
          wctx.globalAlpha = 1;
        }
        return;
      }
      // Bits into word: every pair lerps; a contour without a partner grows
      // out of, or shrinks into, the nearest glyph across.
      wctx.beginPath();
      for (const [i, j, near] of slot.pairs) {
        const a = i >= 0 ? slot.from[i] : collapsed(near >= 0 ? slot.from[near] : slot.to[j], slot.to[j].length);
        const b = j >= 0 ? slot.to[j] : collapsed(near >= 0 ? slot.to[near] : slot.from[i], slot.from[i].length);
        const mixed = a.map((v, q) => v + (b[q] - v) * morph);
        trace(mixed, at);
      }
      wctx.fillStyle = ink;
      wctx.fill('nonzero');
    });
  };

  function trace(pts: number[], at: (pts: number[], i: number) => number[]) {
    for (let i = 0; i < pts.length; i += 2) {
      const [px, py] = at(pts, i);
      if (i) wctx.lineTo(px, py);
      else wctx.moveTo(px, py);
    }
    wctx.closePath();
  }

  const drawWire = (p: number, now: number) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    const shown = span(p, PRIVACY.wire[0], PRIVACY.wire[0] + 0.03);
    if (shown <= 0) return;
    const s = getComputedStyle(figure);
    const ink = s.getPropertyValue('--ink').trim();
    const muted = s.getPropertyValue('--muted').trim();
    const box = canvas.getBoundingClientRect();
    /** A device's drawing on the canvas: its centre and half its size. */
    const place = (key: string) => {
      const b = ends.get(key)!.querySelector('svg')!.getBoundingClientRect();
      return { x: (b.left + b.width / 2 - box.left) * dpr, y: (b.top + b.height / 2 - box.top) * dpr, hw: (b.width / 2) * dpr, hh: (b.height / 2) * dpr };
    };
    const relay = place('relay');

    links.forEach(([from, to, step], lane) => {
      const on = step === 0 ? 1 : span(p, step === 1 ? PRIVACY.household : PRIVACY.roaming, (step === 1 ? PRIVACY.household : PRIVACY.roaming) + 0.03);
      if (on <= 0) return;
      const a = place(from);
      const b = place(to);
      // Phone to the relay's near side, through it, and on to the node, in
      // two soft curves that leave each drawing clear.
      const pad = 14 * dpr;
      const a0 = { x: a.x + a.hw + pad, y: a.y };
      // Each connection keeps its own lane through the relay, so its bytes never overprint another's.
      const ly = relay.y + relay.hh * 0.2 + (lane - (links.length - 1) / 2) * 11 * dpr;
      const r0 = { x: relay.x - relay.hw * 0.86, y: ly };
      const r1 = { x: relay.x + relay.hw * 0.86, y: ly };
      const b0 = { x: b.x - b.hw - pad, y: b.y };
      const curve = (q0: { x: number; y: number }, q1: { x: number; y: number }) => {
        const k = (q1.x - q0.x) * 0.5;
        const pts = [];
        for (let i = 0; i <= 40; i += 1) {
          const t = i / 40;
          const u = 1 - t;
          pts.push({
            x: u * u * u * q0.x + 3 * u * u * t * (q0.x + k) + 3 * u * t * t * (q1.x - k) + t * t * t * q1.x,
            y: u * u * u * q0.y + 3 * u * u * t * q0.y + 3 * u * t * t * q1.y + t * t * t * q1.y,
          });
        }
        return pts;
      };
      const pts = [...curve(a0, r0), ...curve(r1, b0)];
      const lens = [0];
      for (let i = 1; i < pts.length; i += 1) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      // The hop through the relay is drawn by the relay, not the wire.
      const inside = (q: { x: number }) => q.x > r0.x + 1 && q.x < r1.x - 1;
      const total = lens[lens.length - 1];
      const along = (d: number) => {
        let i = 1;
        while (i < lens.length - 1 && lens[i] < d) i += 1;
        const t = (d - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]);
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      };

      ctx.globalAlpha = shown * on;
      ctx.strokeStyle = muted;
      ctx.lineWidth = dpr;
      ctx.setLineDash([1 * dpr, 5 * dpr]);
      ctx.beginPath();
      pts.forEach((q, i) => (i && !inside(q) && !inside(pts[i - 1]) ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      // The traffic: asks one way, songs the other, sealed the whole way. In
      // the relay a packet is all the relay has: a couple of hex digits.
      const seed = from.length * 7 + to.length * 3;
      for (let k = 0; k < 6; k += 1) {
        const back = k % 2 === 1;
        const u = still ? (k + 0.5) / 6 : (now * 0.00012 * (back ? 0.8 : 1) + k / 6 + seed * 0.13) % 1;
        const q = along((back ? 1 - u : u) * total);
        ctx.fillStyle = ink;
        if (inside(q)) {
          ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(HEX[(k * 5 + seed) % 16] + HEX[(k * 11 + seed * 3) % 16], q.x, q.y + 3 * dpr);
        } else {
          ctx.beginPath();
          ctx.arc(q.x, q.y, (back ? 3 : 2.2) * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    ctx.globalAlpha = 1;
  };

  /** The prompt as each end of the first wire holds it, `ms` into its trip. */
  const trip = (p: number, ms: number) => {
    const typed = span(ms, ...TRIP.TYPE_MS);
    const crossed = span(ms, ...TRIP.CROSS_MS);
    const arrived = span(ms, ...TRIP.READ_MS);
    const n = Math.round(typed * prompt.length);
    plain.textContent = prompt.slice(0, n);
    plain.classList.toggle('typing', n < prompt.length && n > 0);
    sealed.textContent = cipher.slice(0, Math.round(crossed * cipher.length));
    read.textContent = prompt.slice(0, Math.round(arrived * prompt.length));
    figure.classList.toggle('household', p >= PRIVACY.household);
    figure.classList.toggle('roaming', p >= PRIVACY.roaming);
  };

  requestAnimationFrame(frame);
}

/** A contour shrunk to its centre, `length` numbers long: where a partnerless contour goes. */
function collapsed(pts: number[], length = pts.length): number[] {
  let x = 0;
  let y = 0;
  for (let i = 0; i < pts.length; i += 2) {
    x += pts[i];
    y += pts[i + 1];
  }
  const n = pts.length / 2;
  return Array.from({ length }, (_, i) => (i % 2 ? y / n : x / n));
}
