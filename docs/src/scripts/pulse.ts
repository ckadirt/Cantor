/**
 * The living marks: a small field of cells under Conway's rules, wrapped at
 * its edges, with a playhead sweeping across it like a sequencer's. A live
 * cell the playhead crosses sounds, and is drawn as a note; a field that
 * dies out or settles is reseeded, as a new phrase. Each mark only runs while
 * it is on screen; reduced motion shows one still frame.
 */
import { hash, mulberry32 } from '../../../cantor/src/lenses/face';

const COLUMNS = 18;
const ROWS = 4;
const TICK_MS = 130;
/** How full a new phrase starts. */
const DENSITY = 0.42;

/** A cell's glyph: a beat on the playhead, a held note once it has lived a while, a dot of grid when empty. */
const GLYPH = { note: '♪', chord: '♫', young: '•', old: '♩', fading: '∘', empty: '·', head: '│' } as const;

type Mark = { el: HTMLElement; cells: HTMLElement[]; random: () => number; alive: Uint8Array; age: Uint8Array; gone: Uint8Array; head: number; seen: string[] };

export function startPulses() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const marks: Mark[] = [...document.querySelectorAll<HTMLElement>('[data-pulse]')].map((el) => {
    el.textContent = '';
    const cells: HTMLElement[] = [];
    for (let r = 0; r < ROWS; r += 1) {
      for (let c = 0; c < COLUMNS; c += 1) {
        const i = document.createElement('i');
        el.appendChild(i);
        cells.push(i);
      }
      if (r < ROWS - 1) el.appendChild(document.createTextNode('\n'));
    }
    const mark: Mark = {
      el,
      cells,
      random: mulberry32(hash(el.dataset.pulse ?? '')),
      alive: new Uint8Array(COLUMNS * ROWS),
      age: new Uint8Array(COLUMNS * ROWS),
      gone: new Uint8Array(COLUMNS * ROWS),
      head: 0,
      seen: [],
    };
    reseed(mark);
    for (let k = 0; k < 3; k += 1) step(mark);
    paint(mark);
    return mark;
  });
  if (still) return;

  let last = 0;
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (now - last < TICK_MS) return;
    last = now;
    for (const m of marks) {
      const r = m.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      step(m);
      paint(m);
    }
  };
  requestAnimationFrame(frame);
}

function reseed(m: Mark) {
  for (let i = 0; i < m.alive.length; i += 1) {
    m.alive[i] = m.random() < DENSITY ? 1 : 0;
    m.age[i] = 0;
  }
  m.seen = [];
}

/** One beat: the playhead moves on; every time it wraps, the field takes a generation. */
function step(m: Mark) {
  m.head = (m.head + 1) % COLUMNS;
  for (let i = 0; i < m.gone.length; i += 1) if (m.gone[i] > 0) m.gone[i] -= 1;
  // The field takes six generations a sweep, so it changes under the playhead.
  if (m.head % (COLUMNS / 6) !== 0) return;
  const next = new Uint8Array(m.alive.length);
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLUMNS; c += 1) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr || dc) n += m.alive[((r + dr + ROWS) % ROWS) * COLUMNS + ((c + dc + COLUMNS) % COLUMNS)];
        }
      }
      const i = r * COLUMNS + c;
      next[i] = n === 3 || (m.alive[i] && n === 2) ? 1 : 0;
      if (m.alive[i] && !next[i]) m.gone[i] = 3;
      m.age[i] = next[i] ? Math.min(255, m.age[i] + 1) : 0;
    }
  }
  m.alive = next;
  // A field that dies out, or repeats itself, starts a new phrase.
  const key = m.alive.join('');
  const population = m.alive.reduce((a, b) => a + b, 0);
  if (population < 4 || m.seen.includes(key)) reseed(m);
  else m.seen = [...m.seen.slice(-5), key];
}

function paint(m: Mark) {
  for (let r = 0; r < ROWS; r += 1) {
    // Two live cells struck together on the playhead are a chord.
    let struck = 0;
    for (let rr = 0; rr < ROWS; rr += 1) struck += m.alive[rr * COLUMNS + m.head];
    for (let c = 0; c < COLUMNS; c += 1) {
      const i = r * COLUMNS + c;
      const onHead = c === m.head;
      const glyph = m.alive[i]
        ? onHead
          ? struck > 1 ? GLYPH.chord : GLYPH.note
          : m.age[i] > 2 ? GLYPH.old : GLYPH.young
        : onHead
          ? GLYPH.head
          : m.gone[i] > 0 ? GLYPH.fading : GLYPH.empty;
      const cell = m.cells[i];
      if (cell.textContent !== glyph) cell.textContent = glyph;
      cell.className = onHead ? 'head' : m.alive[i] ? 'live' : m.gone[i] > 0 ? 'fading' : '';
    }
  }
}
