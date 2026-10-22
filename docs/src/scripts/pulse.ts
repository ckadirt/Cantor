/**
 * The living marks: a small field of cells under a life-like rule, wrapped at
 * its sides (not top to bottom: four rows wrapped settle into blinking
 * columns), with playheads sweeping across it like a sequencer's. A live
 * cell a playhead crosses sounds, and is drawn struck; a field that dies out
 * or settles is reseeded, as a new phrase. Each section has its own voice:
 * its rule, its size, its tempo and its glyphs. Each mark only runs while it
 * is on screen; reduced motion shows one still frame.
 */
import { hash, mulberry32 } from '../../../cantor/src/lenses/face';

type Glyphs = {
  /** A live cell, struck by a playhead; several struck at once. */
  note: string;
  chord: string;
  /** A live cell, newly born and once it has held a while. */
  young: string;
  old: string;
  /** A cell that has just died, an empty one, and the playhead over an empty one. */
  fading: string;
  empty: string;
  head: string;
};

type Voice = {
  columns: number;
  rows: number;
  /** Life-like rule: neighbour counts that bear a cell, and that keep one. */
  born: number[];
  survive: number[];
  tickMs: number;
  /** Generations the field takes per sweep of a playhead. */
  generations: number;
  density: number;
  /** Playheads, spread evenly across; `bounce` sweeps back and forth. */
  heads: number;
  bounce?: boolean;
  glyphs: Glyphs;
  /** Draw live cells as joints of a network, by which neighbours they touch. */
  wires?: boolean;
};

const NOTES: Glyphs = { note: '♪', chord: '♫', young: '•', old: '♩', fading: '∘', empty: '·', head: '│' };

/** Each section's voice, by the name its mark is given. */
const VOICES: Record<string, Voice> = {
  // A song: Conway's own rule, notes on a staff.
  shape: { columns: 18, rows: 4, born: [3], survive: [2, 3], tickMs: 130, generations: 6, density: 0.42, heads: 1, glyphs: NOTES },
  // A library: wider and quicker, HighLife's replicators, two playheads apart.
  map: { columns: 24, rows: 4, born: [3, 6], survive: [2, 3], tickMs: 95, generations: 8, density: 0.4, heads: 2,
    glyphs: { ...NOTES, young: '∙', old: '•', note: '●', chord: '◉', fading: '·', empty: ' ', head: '╎' } },
  // An identity: bits, born and kept by Day & Night's symmetric rule.
  account: { columns: 16, rows: 4, born: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8], tickMs: 150, generations: 4, density: 0.38, heads: 1,
    glyphs: { note: '1', chord: '1', young: '1', old: '1', fading: '0', empty: '0', head: '▏' } },
  // A round trip: a playhead that goes there and comes back.
  how: { columns: 18, rows: 4, born: [3], survive: [2, 3], tickMs: 110, generations: 6, density: 0.4, heads: 1, bounce: true,
    glyphs: { ...NOTES, young: '›', old: '»', note: '◆', chord: '◈', fading: '·', empty: ' ', head: '┊' } },
  // Shared: two voices in canon, half a bar apart.
  share: { columns: 20, rows: 4, born: [3], survive: [2, 3], tickMs: 125, generations: 5, density: 0.44, heads: 2, glyphs: NOTES },
  // A network: Mazectric's corridors, drawn as wires.
  network: { columns: 22, rows: 4, born: [3], survive: [1, 2, 3, 4], tickMs: 160, generations: 11, density: 0.18, heads: 1, wires: true,
    glyphs: { ...NOTES, note: '◍', chord: '◍', fading: '·', empty: ' ', head: '┆' } },
  // The source: brackets opening and closing.
  open: { columns: 18, rows: 4, born: [3], survive: [2, 3], tickMs: 120, generations: 6, density: 0.4, heads: 1,
    glyphs: { note: '}', chord: ']', young: '(', old: '{', fading: '.', empty: ' ', head: '|' } },
};

type Mark = {
  el: HTMLElement;
  voice: Voice;
  cells: HTMLElement[];
  random: () => number;
  alive: Uint8Array;
  age: Uint8Array;
  gone: Uint8Array;
  beat: number;
  seen: string[];
};

export function startPulses() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const marks: Mark[] = [...document.querySelectorAll<HTMLElement>('[data-pulse]')].map((el) => {
    const name = el.dataset.pulse ?? 'shape';
    const voice = VOICES[name] ?? VOICES.shape;
    el.textContent = '';
    const cells: HTMLElement[] = [];
    for (let r = 0; r < voice.rows; r += 1) {
      for (let c = 0; c < voice.columns; c += 1) {
        const i = document.createElement('i');
        el.appendChild(i);
        cells.push(i);
      }
      if (r < voice.rows - 1) el.appendChild(document.createTextNode('\n'));
    }
    const size = voice.columns * voice.rows;
    const mark: Mark = { el, voice, cells, random: mulberry32(hash(name)), alive: new Uint8Array(size), age: new Uint8Array(size), gone: new Uint8Array(size), beat: 0, seen: [] };
    reseed(mark);
    for (let k = 0; k < 3; k += 1) step(mark);
    paint(mark);
    return mark;
  });
  if (still) return;

  const last = new Map<Mark, number>();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    for (const m of marks) {
      if (now - (last.get(m) ?? 0) < m.voice.tickMs) continue;
      last.set(m, now);
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
    m.alive[i] = m.random() < m.voice.density ? 1 : 0;
    m.age[i] = 0;
  }
  m.seen = [];
}

/** Where each playhead stands on this beat. */
function heads(m: Mark): number[] {
  const { columns, heads: count, bounce } = m.voice;
  return Array.from({ length: count }, (_, k) => {
    const b = m.beat + Math.round((k * columns) / count);
    if (!bounce) return b % columns;
    const span = columns * 2 - 2;
    const p = b % span;
    return p < columns ? p : span - p;
  });
}

/** One beat: the playheads move on; every so many beats the field takes a generation. */
function step(m: Mark) {
  const { columns, rows, born, survive, generations } = m.voice;
  m.beat += 1;
  for (let i = 0; i < m.gone.length; i += 1) if (m.gone[i] > 0) m.gone[i] -= 1;
  if (m.beat % Math.max(1, Math.round(columns / generations)) !== 0) return;
  const next = new Uint8Array(m.alive.length);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const n = neighbours(m, r, c);
      const i = r * columns + c;
      next[i] = (m.alive[i] ? survive : born).includes(n) ? 1 : 0;
      if (m.alive[i] && !next[i]) m.gone[i] = 3;
      m.age[i] = next[i] ? Math.min(255, m.age[i] + 1) : 0;
    }
  }
  m.alive = next;
  // A field that dies out, fills up, or repeats itself, starts a new phrase.
  const key = m.alive.join('');
  const population = m.alive.reduce((a, b) => a + b, 0);
  if (population < 4 || population > m.alive.length * 0.8 || m.seen.includes(key)) reseed(m);
  else m.seen = [...m.seen.slice(-5), key];
}

function neighbours(m: Mark, r: number, c: number) {
  const { columns, rows } = m.voice;
  let n = 0;
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      const rr = r + dr;
      if ((dr || dc) && rr >= 0 && rr < rows) n += m.alive[rr * columns + ((c + dc + columns) % columns)];
    }
  }
  return n;
}

/** A live cell as a joint of wire, by which of its four neighbours live too. */
function wire(m: Mark, r: number, c: number) {
  const { columns, rows } = m.voice;
  const at = (rr: number, cc: number) => (rr < 0 || rr >= rows ? 0 : m.alive[rr * columns + ((cc + columns) % columns)]);
  const key = (at(r - 1, c) ? 1 : 0) | (at(r, c + 1) ? 2 : 0) | (at(r + 1, c) ? 4 : 0) | (at(r, c - 1) ? 8 : 0);
  return ['∙', '╵', '╶', '└', '╷', '│', '┌', '├', '╴', '┘', '─', '┴', '┐', '┤', '┬', '┼'][key];
}

function paint(m: Mark) {
  const { columns, rows, glyphs } = m.voice;
  const on = heads(m);
  for (let c = 0; c < columns; c += 1) {
    const struck = on.includes(c);
    // Live cells struck together on a playhead are a chord.
    let together = 0;
    if (struck) for (let r = 0; r < rows; r += 1) together += m.alive[r * columns + c];
    for (let r = 0; r < rows; r += 1) {
      const i = r * columns + c;
      const glyph = m.alive[i]
        ? struck
          ? together > 1 ? glyphs.chord : glyphs.note
          : m.voice.wires ? wire(m, r, c) : m.age[i] > 2 ? glyphs.old : glyphs.young
        : struck
          ? glyphs.head
          : m.gone[i] > 0 ? glyphs.fading : glyphs.empty;
      const cell = m.cells[i];
      if (cell.textContent !== glyph) cell.textContent = glyph;
      cell.className = struck ? 'head' : m.alive[i] ? 'live' : m.gone[i] > 0 ? 'fading' : '';
    }
  }
}
