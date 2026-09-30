import { mulberry32 } from '../lenses/face';
import { fnv1a } from './hash';

/**
 * KNOBS — Station, the node's mark (`docs/interfacealpha/nodes.html#mark`):
 * a polygon drawn from the node's public key, with one edge left open as its
 * gate, and a dot inside for each model it has installed.
 *
 * Every length is in units of the polygon's circumradius, so a station is the
 * same drawing at 18 px beside a name and at 64 px as a clef.
 */
export const STATION_KNOBS = {
  /** Three to seven sides: few enough to read as a shape at 18 px. */
  MIN_SIDES: 3,
  SIDE_CHOICES: 5,
  /**
   * How much of the gate edge each side keeps, from its corner: the rest is
   * the opening. 0.28 leaves 44 % of the edge open — a gap, not a nick.
   */
  GATE_STUB: 0.28,
  /** Where the model dots stand: one at the centre, two on a small ring, more on a larger one. */
  PAIR_RING: 3.4 / 14.5,
  DOT_RING: 4.6 / 14.5,
  /** More models than this still draw this many dots: it is a mark, not a count. */
  MAX_DOTS: 6,
} as const;

export type Point = readonly [number, number];

export type Station = Readonly<{
  /** How many sides the polygon has. */
  sides: number;
  /** Which edge is the gate, counted from the first vertex. */
  gate: number;
  /**
   * The outline as one open polyline: from the stub beside the gate, round
   * every corner, to the stub on the gate's other side.
   */
  outline: readonly Point[];
  /** A dot per installed model, up to `MAX_DOTS`. */
  dots: readonly Point[];
}>;

/**
 * A node's station, from its public key and how many models it has.
 *
 * Pure and deterministic: the same key draws the same station on every
 * device, which is what lets a person recognise a node by its mark before
 * they read its name. The rotation, the number of sides and which edge opens
 * all come from the key.
 */
export function station(nodePublicKey: string, models: number): Station {
  const seed = fnv1a(nodePublicKey);
  const random = mulberry32(seed);
  const sides = STATION_KNOBS.MIN_SIDES + (seed % STATION_KNOBS.SIDE_CHOICES);
  const turn = (random() * Math.PI * 2) / sides - Math.PI / 2;
  const gate = Math.floor(random() * sides);
  const corners: Point[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = turn + (index * Math.PI * 2) / sides;
    corners.push([Math.cos(angle), Math.sin(angle)]);
  }
  const from = corners[gate];
  const to = corners[(gate + 1) % sides];
  const stub = STATION_KNOBS.GATE_STUB;
  const between = (a: Point, b: Point, t: number): Point => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const outline: Point[] = [between(to, from, stub)];
  for (let step = 1; step <= sides; step += 1) {
    outline.push(corners[(gate + step) % sides]);
  }
  outline.push(between(from, to, stub));
  return { sides, gate, outline, dots: modelDots(models) };
}

/** The dots inside a station: one per model, spaced round its centre. */
export function modelDots(models: number): Point[] {
  const count = Math.min(
    Math.max(0, Math.floor(models)),
    STATION_KNOBS.MAX_DOTS,
  );
  if (count === 0) return [];
  if (count === 1) return [[0, 0]];
  const ring = count === 2 ? STATION_KNOBS.PAIR_RING : STATION_KNOBS.DOT_RING;
  const dots: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
    dots.push([ring * Math.cos(angle), ring * Math.sin(angle)]);
  }
  return dots;
}
