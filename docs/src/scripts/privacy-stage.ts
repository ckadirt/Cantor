/**
 * The landing's privacy stage, in ink. First the twelve words a phone makes
 * for itself, revealed as the app reveals them (`IdentityPanel.tsx`): every
 * word written on as the 11 bits it encodes, then each bit string morphing
 * into its word, once the form an account would need has struck itself out.
 * Then how it works (`network-stage.ts`): a phone, the relay and a computer,
 * a friend's phone, and a whole network.
 *
 * The scroll says which scene is showing; inside it everything runs on time.
 */
import { writePhase, writeSubAlpha } from '../../../cantor/src/motion/text';
import type { PhraseSlot } from '../lib/phrase';
import { startNetworkStage, type Scene } from './network-stage';
import { phoneMark } from '../lib/art';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** The motion engine's one easing: manim's smooth, 10t³ − 15t⁴ + 6t⁵ (`motion/geometry.ts`). */
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * How much scroll each scene is given, in screen heights: about a screen
 * each, since everything inside a scene plays on time.
 */
const SCENES_VH = { words: 85, how: 110, share: 85, network: 100 } as const;
/** The stage's scroll run: its height is this plus the screen it is pinned in. */
export const PRIVACY_RUN_VH = Object.values(SCENES_VH).reduce((a, b) => a + b, 0);
const at = (vh: number) => vh / PRIVACY_RUN_VH;

/** The windows of the stage, in its progress. */
export const PRIVACY = {
  words: [0, at(SCENES_VH.words)],
  /** The wire holds to the end of the stage: past 1, so it never lifts out while pinned. */
  wire: [at(SCENES_VH.words), 1.01],
  share: at(SCENES_VH.words + SCENES_VH.how),
  network: at(SCENES_VH.words + SCENES_VH.how + SCENES_VH.share),
} as const;

const sceneAt = (p: number): Scene | null =>
  p < PRIVACY.wire[0] ? null : p < PRIVACY.share ? 'how' : p < PRIVACY.network ? 'share' : 'network';

/**
 * Before the words: the form an account would need, drawn field by field,
 * struck through, and gone.
 */
const FORM = { STAGGER_MS: 140, APPEAR_MS: 400, STRIKE_AT_MS: 1500, STRIKE_MS: 380, GONE_AT_MS: 2500, GONE_MS: 450 } as const;
const FORM_MS = FORM.GONE_AT_MS + FORM.GONE_MS;

/** The reveal's clock, as the app's identity panel keeps it (`IdentityPanel.tsx`). */
const REVEAL = {
  PREPARE_MS: 350,
  BITS_WRITE_MS: 800,
  BITS_HOLD_MS: 180,
  MORPH_STAGGER_MS: 100,
  MORPH_MS: 480,
} as const;
const COLUMNS = 3;
/** On a wide screen the words take this much of the sheet; the phones they unlock stand in the rest. */
const GRID_SHARE = 0.62;

/**
 * After the words: they flow into your phone and draw its mark, which is
 * you; then a new phone appears, the same words flow into it, and the same
 * mark draws. Times from the moment the last word settles.
 */
const KEYS = { FIRST_AT_MS: 700, SECOND_AT_MS: 3300, FLY_MS: 950, FLY_STAGGER_MS: 75, NOTE_AT_MS: 4300 } as const;
const WORDS_DONE_MS =
  REVEAL.PREPARE_MS + REVEAL.BITS_WRITE_MS + REVEAL.BITS_HOLD_MS + 11 * REVEAL.MORPH_STAGGER_MS + REVEAL.MORPH_MS;

export function startPrivacyStage(stage: HTMLElement, progress: () => number) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the twelve words
  const phrase = stage.querySelector<HTMLElement>('[data-phrase]')!;
  const slots = JSON.parse(phrase.querySelector('script')!.textContent!) as PhraseSlot[];
  const words = phrase.querySelector<HTMLCanvasElement>('canvas')!;
  const wctx = words.getContext('2d')!;
  const fields = [...phrase.querySelectorAll<HTMLElement>('[data-signup] li')];
  const keys = [...phrase.querySelectorAll<HTMLElement>('[data-key]')];
  const note = phrase.querySelector<HTMLElement>('figcaption')!;
  /** Where each word sits on the canvas once settled, for the flight to the phones. */
  const anchors: { x: number; y: number }[] = [];
  const spokes = phoneMark('your phone');
  /** When the reveal began; null until the words are on screen. */
  let revealedAt: number | null = null;

  // ---- how it works
  const network = startNetworkStage(stage.querySelector<HTMLElement>('[data-wire]')!);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const r = stage.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) {
      revealedAt = null;
      network.update(null, now);
      return;
    }
    const p = progress();
    // The reveal plays once the words are on screen, and again each time they return.
    const showing = p < PRIVACY.words[1] && r.top < innerHeight * 0.4;
    if (!showing) revealedAt = null;
    else if (revealedAt === null) revealedAt = now;
    if (p < PRIVACY.words[1] + 0.02) {
      const ms = still ? Infinity : revealedAt === null ? 0 : now - revealedAt;
      form(ms);
      drawWords(ms - FORM_MS);
      drawKeys(ms - FORM_MS - WORDS_DONE_MS);
    }
    network.update(sceneAt(p), now);
  };

  const form = (ms: number) => {
    fields.forEach((li, k) => {
      const shown = clamp((ms - k * FORM.STAGGER_MS) / FORM.APPEAR_MS);
      const struck = smoother(clamp((ms - FORM.STRIKE_AT_MS - k * FORM.STAGGER_MS) / FORM.STRIKE_MS));
      const gone = clamp((ms - FORM.GONE_AT_MS - k * 60) / FORM.GONE_MS);
      li.style.opacity = String(shown * (1 - gone));
      li.style.transform = `translateY(${(1 - shown) * 8 - gone * 10}px)`;
      li.querySelector<HTMLElement>('b')!.style.transform = `scaleX(${struck})`;
    });
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
    const wide = keys.length > 0 && words.clientWidth > 640;
    const column = ((wide ? w * GRID_SHARE : w) - gap * (COLUMNS - 1)) / COLUMNS;
    const rows = Math.ceil(slots.length / COLUMNS);
    const widest = Math.max(...slots.map((slot) => Math.max(slot.bitsWidth, slot.wordWidth)));
    const em = Math.min((column - number) / widest, h / rows / 1.7);
    const row = h / rows;
    const t = still ? Infinity : ms - REVEAL.PREPARE_MS;

    slots.forEach((slot, k) => {
      const x = (k % COLUMNS) * (column + gap);
      const base = Math.floor(k / COLUMNS) * row + row / 2 + em * 0.34;
      const ox = x + number;
      // The slots' numbers arrive with the bits, once the form has gone.
      wctx.globalAlpha = clamp(t / 300);
      wctx.fillStyle = faint;
      wctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
      wctx.textAlign = 'left';
      wctx.fillText(String(k + 1).padStart(2, '0'), x, base);
      wctx.globalAlpha = 1;
      const at = (pts: number[], i: number) => [ox + pts[i] * em, base + pts[i + 1] * em];
      anchors[k] = { x: ox + (slot.wordWidth * em) / 2, y: base - em * 0.3 };

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

  /** The words flowing into a phone, and the phone's mark drawing as they land. */
  const drawKeys = (ms: number) => {
    const settled = still ? Infinity : ms;
    keys.forEach((key, n) => {
      const at = n === 0 ? KEYS.FIRST_AT_MS : KEYS.SECOND_AT_MS;
      key.style.opacity = String(clamp((settled - at + 500) / 500));
    });
    note.classList.toggle('free', settled >= KEYS.NOTE_AT_MS);
    if (!keys.length || words.clientWidth <= 640) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const box = words.getBoundingClientRect();
    const ink = getComputedStyle(phrase).getPropertyValue('--ink').trim();
    keys.forEach((key, n) => {
      const at = n === 0 ? KEYS.FIRST_AT_MS : KEYS.SECOND_AT_MS;
      const u = settled - at;
      if (u < 0) return;
      const b = key.querySelector('svg')!.getBoundingClientRect();
      const cx = (b.left - box.left + b.width * 0.5) * dpr;
      const cy = (b.top - box.top + b.height * 0.49) * dpr;
      const r = b.width * 0.22 * dpr;
      let landed = 0;
      anchors.forEach((a, k) => {
        const f = clamp((u - k * KEYS.FLY_STAGGER_MS) / KEYS.FLY_MS);
        if (f >= 1) {
          landed += 1;
          return;
        }
        if (f <= 0) return;
        const e = smoother(f);
        // Each word leaves as a point of light and arcs into the phone.
        const x = a.x + (cx - a.x) * e;
        const y = a.y + (cy - a.y) * e - Math.sin(Math.PI * e) * 40 * dpr;
        wctx.globalAlpha = 0.35 + 0.65 * (1 - Math.abs(0.5 - e) * 2);
        wctx.fillStyle = ink;
        wctx.beginPath();
        wctx.arc(x, y, 2.4 * dpr, 0, Math.PI * 2);
        wctx.fill();
      });
      wctx.globalAlpha = 1;
      // The phone's mark, drawn from its key: the same words, the same mark.
      const drawn = landed / anchors.length;
      wctx.strokeStyle = ink;
      wctx.lineWidth = 1.3 * dpr;
      wctx.lineCap = 'round';
      spokes.forEach((sp, i) => {
        const g = clamp(drawn * spokes.length - i);
        if (g <= 0) return;
        wctx.beginPath();
        wctx.moveTo(cx + sp.x1 * r, cy + sp.y1 * r);
        wctx.lineTo(cx + (sp.x1 + (sp.x2 - sp.x1) * g) * r, cy + (sp.y1 + (sp.y2 - sp.y1) * g) * r);
        wctx.stroke();
      });
      if (drawn > 0) {
        wctx.fillStyle = ink;
        wctx.beginPath();
        wctx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2);
        wctx.fill();
      }
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
