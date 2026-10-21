/**
 * A sample library for the landing's maps: songs made on a node and files
 * imported from a phone, over a few months. The titles and artists are
 * invented; everything else follows the app. Recipes are built the way the
 * app builds them (`useFieldController.ts`), and the map is seated by the
 * app's own layout (`cantor/src/field/layout.ts`).
 */
import { facePoints, FACE_MAX_EXTENT, metadataSeed, mulberry32, type FaceRecipe } from '../../../cantor/src/lenses/face';
import { layoutField } from '../../../cantor/src/field/layout';
import { byDate } from '../../../cantor/src/field/arrangements/byTime';
import { byArtist } from '../../../cantor/src/field/arrangements/byRecord';
import type { Arrangement, FieldEntity } from '../../../cantor/src/field/types';

/** How a song's mark is inked: the circle's availability order. */
export type Ink = 'remote' | 'cached' | 'downloaded';

export type SampleSong = {
  entity: FieldEntity;
  recipe: FaceRecipe;
  title: string;
  /** A model for a made song, an artist for an imported one. */
  byline: string;
  ink: Ink;
};

const MADE = [
  'a slow blues, at dusk', 'rain on a tin roof', 'a waltz for two', 'the long drive home',
  'hum of the city', 'an empty ballroom', 'cumbia under the bridge', 'first light',
  'salt and cedar', 'a hymn for nobody', 'night bus', 'lemon trees', 'a quiet anthem',
  'morning, no words', 'a lullaby in D', 'brass for a small parade', 'the ferry at six',
  'two guitars arguing', 'a slow reel', 'paper lanterns', 'a song for my mother',
  'snow on the antenna', 'the last train out', 'bolero, half asleep', 'copper and smoke',
  'a march for the dog', 'low tide', 'after the rain, again',
];
const MODELS = ['acestep:1.5-fast', 'acestep:1.5-quality', 'levo2:1.0-balanced'];

/** More captions, so the sample reads as a library rather than a handful. */
const MOODS = ['slow', 'bright', 'late', 'quiet', 'warm', 'small', 'old', 'loud', 'blue', 'soft'];
const THINGS = ['waltz', 'reel', 'ballad', 'march', 'lament', 'groove', 'hymn', 'shuffle', 'drone', 'serenade', 'chorale', 'bossa'];
const PLACES = ['for the harbour', 'in the attic', 'after midnight', 'for two voices', 'at the market', 'on the roof', 'for a cello', 'in the rain'];
const MADE_COUNT = 112;
function caption(index: number): string {
  if (index < MADE.length) return MADE[index];
  const n = index - MADE.length;
  return `a ${MOODS[n % MOODS.length]} ${THINGS[(n * 7) % THINGS.length]} ${PLACES[(n * 5) % PLACES.length]}`;
}

/** Invented records, the way a phone's folders arrive. */
const RECORDS: readonly (readonly [string, string, readonly string[]])[] = [
  ['Marisol Vega', 'Casa de Arena', ['Puerto', 'Sal', 'La Vuelta', 'Arena', 'Malecón']],
  ['The Lowlands', 'Field Notes', ['Barn Owl', 'Fence Line', 'October', 'Wheat']],
  ['Ondine', 'Glass', ['Prism', 'Shards', 'Clear', 'Frost']],
  ['Hiro Tanabe', 'Night Kitchen', ['Steam', 'Midnight Noodle', 'Neon']],
  ['Ada Obi', 'Lagos Morning', ['Danfo', 'Harmattan', 'Sunday', 'Okada', 'Lekki']],
  ['Northern Rooms', 'Static', ['Hiss', 'Tape', 'Dial Tone']],
  ['Lucía Arce', 'Sierra', ['Cumbre', 'Niebla', 'Pino', 'Ríos']],
];

const DAY = 86_400_000;
const START = Date.UTC(2026, 6, 6);

function made(index: number, random: () => number): SampleSong {
  const title = caption(index);
  const model = MODELS[Math.floor(random() * MODELS.length)];
  const createdAtMs = START - 120 * DAY + Math.floor(Math.pow(random(), 0.7) * 225) * DAY;
  const durationMs = (110 + Math.floor(random() * 170)) * 1000;
  const seed = Math.floor(random() * 2 ** 32) >>> 0;
  const id = `made-${index}`;
  const roll = random();
  return {
    entity: { key: `node:${id}`, nodePublicKey: 'node', entityId: id, kind: 'song', createdAtMs, durationMs, tags: [], model },
    recipe: { seed, id, model, durationMs },
    title,
    byline: model,
    ink: roll < 0.3 ? 'remote' : roll < 0.55 ? 'cached' : 'downloaded',
  };
}

function imported(): SampleSong[] {
  const songs: SampleSong[] = [];
  RECORDS.forEach(([artist, album, titles], r) => {
    const arrivedMs = START - 110 * DAY + (10 + r * 31) * DAY;
    titles.forEach((title, t) => {
      const id = `device-${r}-${t}`;
      const durationMs = (150 + ((r * 37 + t * 53) % 120)) * 1000;
      songs.push({
        entity: {
          key: `device:${id}`,
          nodePublicKey: 'device',
          entityId: id,
          kind: 'song',
          createdAtMs: arrivedMs + t * 1000,
          durationMs,
          tags: [],
          record: { albumKey: `${artist}/${album}`, album, artist, track: t + 1, arrivedMs },
        },
        // As the app draws an imported song: from its tags, marked imported.
        recipe: { seed: metadataSeed(title, artist), id, model: 'device', durationMs, imported: true },
        title,
        byline: artist,
        ink: 'downloaded',
      });
    });
  });
  return songs;
}

export function sampleLibrary(): SampleSong[] {
  const random = mulberry32(0xca7704);
  return [...Array.from({ length: MADE_COUNT }, (_, i) => made(i, random)), ...imported()];
}

export type MapMark = SampleSong & { x: number; y: number };
export type MapGroup = { label: string; x: number; y: number; section?: string };
export type FieldMap = {
  marks: MapMark[];
  groups: MapGroup[];
  box: { x: number; y: number; w: number; h: number };
  /** Screen pixels per world unit at the field level, on the phone the layout was made for. */
  fitScale: number;
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function groupLabel(arrangement: Arrangement, key: string, label: string): string {
  if (arrangement.key !== 'time') return label;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : label;
}

/**
 * The library seated by the app's layout at the field level: every song at its
 * bloomed place round its cluster's centre, as the map shows them.
 */
export function fieldMap(by: 'month' | 'artist', songs = sampleLibrary()): FieldMap {
  const arrangement: Arrangement = by === 'month' ? { ...byDate('month'), key: 'time' } : byArtist;
  const layout = layoutField({
    entities: songs.map((song) => song.entity),
    arrangement,
    // A phone's screen: the field's packing is made for one.
    viewport: { width: 390, height: 844 },
  });
  const byKey = new Map(songs.map((song) => [song.entity.key, song]));
  const marks: MapMark[] = layout.placements.map((p) => ({
    ...byKey.get(p.entityKey)!,
    x: p.targetX + p.targetBloomX,
    y: p.targetY + p.targetBloomY,
  }));
  const sections = new Map(arrangement.group(songs.map((s) => s.entity)).map((g) => [g.key, g.section]));
  const groups: MapGroup[] = layout.groups.map((g) => ({
    label: groupLabel(arrangement, g.key, g.label),
    x: g.cx,
    y: g.top,
    section: sections.get(g.key),
  }));
  const xs = marks.map((m) => m.x);
  const ys = [...marks.map((m) => m.y), ...groups.map((g) => g.y)];
  const pad = 24 / layout.fitScale;
  const box = {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad * 2,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 3,
  };
  return { marks, groups, box, fitScale: layout.fitScale };
}

/** A face's contour as a path of radius `r` round (`cx`, `cy`). */
export function facePathAt(recipe: FaceRecipe, cx: number, cy: number, r: number): string {
  const scale = r / FACE_MAX_EXTENT;
  const d = facePoints(recipe, 64)
    .map((p, i) => `${i ? 'L' : 'M'}${(cx + p.x * scale).toFixed(2)} ${(cy + p.y * scale).toFixed(2)}`)
    .join('');
  return `${d}Z`;
}
