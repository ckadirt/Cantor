/**
 * Which of a cut's flights can be on screen, without asking each one.
 *
 * The field drew by walking every face and every row on every frame, working
 * out where each one stood and only then skipping the ones off the screen: at
 * 872 songs ~3 ms of faces and ~2 ms of rows per frame on the Xiaomi, the same
 * standing inside one song as looking at the whole map, and growing with the
 * library. An index is built once per join, on the UI thread: each flight is
 * a box in world space that holds every place the flight can stand during
 * its cut — both ends, gathered and bloomed — kept in a grid. A frame asks
 * the grid for the boxes under its view, and walks only those, in their
 * original order, so faces still overlap as they did.
 *
 * The answer is a superset: the walk still culls each flight exactly, as it
 * always has. A flight whose box would cover much of the map (a long move
 * across it during a re-cut) is walked every frame rather than filed in
 * every cell.
 */

/** KNOBS */
export const FLIGHT_INDEX_KNOBS = {
  /** Flights per cell, on average, the grid is sized for. */
  PER_CELL: 12,
  /** The most cells along either side of the grid. */
  MAX_SIDE: 128,
  /** A box over more cells than this is walked every frame instead. */
  MAX_SPAN_CELLS: 64,
} as const;

/** The parts of a flight its box is made from. */
export type FlightSeat = Readonly<{
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  fromBloomX: number;
  fromBloomY: number;
  targetBloomX: number;
  targetBloomY: number;
}>;

export type FlightIndex = {
  /** The array the index was built from, compared by identity. */
  source: object;
  count: number;
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** Flight indices by cell, row-major. */
  cells: number[][];
  /** Flights walked every frame: asked to be, or too big to file. */
  always: number[];
  /** The largest bow any flight takes, in screen pixels. */
  bowPx: number;
  /** Which flights this query has met already; see `queryFlightIndex`. */
  seen: Int32Array;
  ask: number;
  /** The last query's answer, reused: a frame allocates nothing. */
  out: number[];
};

/**
 * File every flight of `items` (`seatOf` reads its seat). `alwaysOf` names
 * the flights to walk on every frame whatever the view: a player, drawn
 * where no seat says.
 */
export function buildFlightIndex<T>(
  items: readonly T[],
  seatOf: (item: T) => FlightSeat,
  bowOf: (item: T) => number,
  alwaysOf: (item: T) => boolean,
): FlightIndex {
  'worklet';
  const count = items.length;
  const boxes = new Float64Array(count * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let bowPx = 0;
  for (let index = 0; index < count; index++) {
    const seat = seatOf(items[index]);
    // Bloom runs from none to all of the offset: both ends, both ways.
    const x0 = seat.fromX;
    const x1 = seat.fromX + seat.fromBloomX;
    const x2 = seat.targetX;
    const x3 = seat.targetX + seat.targetBloomX;
    const y0 = seat.fromY;
    const y1 = seat.fromY + seat.fromBloomY;
    const y2 = seat.targetY;
    const y3 = seat.targetY + seat.targetBloomY;
    const lowX = Math.min(x0, x1, x2, x3);
    const highX = Math.max(x0, x1, x2, x3);
    const lowY = Math.min(y0, y1, y2, y3);
    const highY = Math.max(y0, y1, y2, y3);
    boxes[index * 4] = lowX;
    boxes[index * 4 + 1] = lowY;
    boxes[index * 4 + 2] = highX;
    boxes[index * 4 + 3] = highY;
    if (lowX < minX) minX = lowX;
    if (lowY < minY) minY = lowY;
    if (highX > maxX) maxX = highX;
    if (highY > maxY) maxY = highY;
    const bow = Math.abs(bowOf(items[index]));
    if (bow > bowPx) bowPx = bow;
  }
  const always: number[] = [];
  if (count === 0 || !Number.isFinite(minX + minY + maxX + maxY)) {
    for (let index = 0; index < count; index++) always.push(index);
    return {
      source: items,
      count,
      minX: 0,
      minY: 0,
      cell: 1,
      cols: 0,
      rows: 0,
      cells: [],
      always,
      bowPx,
      seen: new Int32Array(count),
      ask: 0,
      out: [],
    };
  }
  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);
  // Sized for `PER_CELL` flights a cell, but never more than `MAX_SIDE`
  // cells along either side: a cut whose flights all stand on one line has
  // no area, and a cell sized from area alone would split that line into
  // millions of cells (the UI thread hung building them).
  const cell = Math.max(
    Math.sqrt((width * height * FLIGHT_INDEX_KNOBS.PER_CELL) / Math.max(count, 1)),
    width / FLIGHT_INDEX_KNOBS.MAX_SIDE,
    height / FLIGHT_INDEX_KNOBS.MAX_SIDE,
  );
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const cells: number[][] = [];
  for (let index = 0; index < cols * rows; index++) cells.push([]);
  for (let index = 0; index < count; index++) {
    if (alwaysOf(items[index])) {
      always.push(index);
      continue;
    }
    const c0 = Math.min(cols - 1, Math.floor((boxes[index * 4] - minX) / cell));
    const r0 = Math.min(rows - 1, Math.floor((boxes[index * 4 + 1] - minY) / cell));
    const c1 = Math.min(cols - 1, Math.floor((boxes[index * 4 + 2] - minX) / cell));
    const r1 = Math.min(rows - 1, Math.floor((boxes[index * 4 + 3] - minY) / cell));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > FLIGHT_INDEX_KNOBS.MAX_SPAN_CELLS) {
      always.push(index);
      continue;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) cells[r * cols + c].push(index);
    }
  }
  return {
    source: items,
    count,
    minX,
    minY,
    cell,
    cols,
    rows,
    cells,
    always,
    bowPx,
    seen: new Int32Array(count),
    ask: 0,
    out: [],
  };
}

/**
 * The flights whose boxes meet the world rect, in ascending order (the
 * index's own array, overwritten by the next query). The flights walked every
 * frame are always among them.
 */
export function queryFlightIndex(
  index: FlightIndex,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): readonly number[] {
  'worklet';
  const out = index.out;
  out.length = 0;
  index.ask += 1;
  if (index.ask >= 2147483647) {
    index.seen.fill(0);
    index.ask = 1;
  }
  const ask = index.ask;
  const seen = index.seen;
  for (let k = 0; k < index.always.length; k++) {
    const at = index.always[k];
    if (seen[at] !== ask) {
      seen[at] = ask;
      out.push(at);
    }
  }
  if (index.cols > 0) {
    const c0 = Math.max(0, Math.floor((minX - index.minX) / index.cell));
    const r0 = Math.max(0, Math.floor((minY - index.minY) / index.cell));
    const c1 = Math.min(index.cols - 1, Math.floor((maxX - index.minX) / index.cell));
    const r1 = Math.min(index.rows - 1, Math.floor((maxY - index.minY) / index.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = index.cells[r * index.cols + c];
        for (let k = 0; k < bucket.length; k++) {
          const at = bucket[k];
          if (seen[at] !== ask) {
            seen[at] = ask;
            out.push(at);
          }
        }
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * The world rect a view sees through a camera, widened by `marginPx` screen
 * pixels on every side.
 */
export function viewRect(
  cameraX: number,
  cameraY: number,
  scale: number,
  width: number,
  height: number,
  marginPx: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  'worklet';
  const halfW = (width / 2 + marginPx) / scale;
  const halfH = (height / 2 + marginPx) / scale;
  return {
    minX: cameraX - halfW,
    minY: cameraY - halfH,
    maxX: cameraX + halfW,
    maxY: cameraY + halfH,
  };
}
