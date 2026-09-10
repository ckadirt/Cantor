import { songDetailOpacity, songDetailPhase } from '../songDetailPhase';
/**
 * The measurement, from the ring it is drawn on to the grain it becomes.
 *
 * One loop draws both poses now, so this reads them out of the draw calls the
 * way `fieldFaces.test.ts` does. Two things are under test and they are
 * different: *when* the ticks arrive — they wait for the descent, then sweep —
 * and *where* they are, which is a circle at one end of the crossing and one
 * time axis at the other.
 */
import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import {
  GRAIN_KNOBS,
  LEVEL_SCALE_RATIOS,
  REPRESENTATION_WINDOWS,
  bandAlphaAt,
} from '../../../field';
import { PLAYER_RING_KNOBS } from '../NativePlayer';
import {
  drawSongDetail,
  type GrainBars,
  type SongDetailModel,
} from '../FieldCanvas';

const viewport = { width: 380, height: 800 };
const fitScale = 0.5;

const model: SongDetailModel = {
  fromX: 0,
  fromY: 0,
  targetX: 0,
  targetY: 0,
  fromBloomX: 0,
  fromBloomY: 0,
  targetBloomX: 0,
  targetBloomY: 0,
  levels: Array.from({ length: 64 }, (_, index) => 0.3 + 0.2 * Math.sin(index)),
  durationSeconds: 120,
};

/** The camera standing still, centred on the song, at a given closeness. */
const recut = {
  fromCamera: { x: 0, y: 0, scale: fitScale },
  toCamera: { x: 0, y: 0, scale: fitScale },
  fromFitScale: fitScale,
  toFitScale: fitScale,
};

type Line = { x0: number; y0: number; x1: number; y1: number };

function recordingCanvas() {
  const lines: Line[] = [];
  const rects: Array<{ x: number; width: number }> = [];
  const canvas = {
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    drawLine: (x0: number, y0: number, x1: number, y1: number) =>
      lines.push({ x0, y0, x1, y1 }),
    drawRect: (rect: { x: number; width: number }) => rects.push(rect),
    drawPath: () => {},
    drawCircle: () => {},
  };
  return { canvas: canvas as unknown as SkCanvas, lines, rects };
}

function paints() {
  const make = () => Skia.Paint();
  return { fill: make(), stroke: make(), ring: make() };
}

function drawAt(options: {
  ratio: number;
  drawn: number;
  grain?: GrainBars | null;
  resolved?: number;
  positionSeconds?: number;
}) {
  const target = recordingCanvas();
  drawSongDetail(
    target.canvas,
    model,
    paints(),
    1,
    recut,
    { value: { x: 0, y: 0, scale: fitScale * options.ratio } } as never,
    { value: fitScale } as never,
    { value: options.positionSeconds ?? 0 } as never,
    options.grain ?? null,
    options.resolved ?? 0,
    options.drawn,
    viewport,
  );
  return target;
}

const ticks = PLAYER_RING_KNOBS.SONG_WAVE_TICKS;
/** The window the screen actually asks for: `ENTRY_SECONDS` about the head. */
const middle = model.durationSeconds / 2;
const centredBars: GrainBars = {
  min: Array.from({ length: 32 }, () => -0.4),
  max: Array.from({ length: 32 }, () => 0.4),
  startSeconds: middle - GRAIN_KNOBS.ENTRY_SECONDS / 2,
  endSeconds: middle + GRAIN_KNOBS.ENTRY_SECONDS / 2,
  label: '12.00s VISIBLE',
};
const atRing = LEVEL_SCALE_RATIOS.song;
const atGrain = GRAIN_KNOBS.ENTRY_RATIO;

describe('the measurement from the ring to the grain', () => {
  it('draws nothing before the descent has settled', () => {
    expect(drawAt({ ratio: atRing, drawn: 0 }).lines).toHaveLength(0);
  });

  it('sweeps rather than appearing all at once', () => {
    const half = drawAt({ ratio: atRing, drawn: 0.5 }).lines.length;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(ticks);
    expect(drawAt({ ratio: atRing, drawn: 1 }).lines).toHaveLength(ticks);
  });

  /**
   * At the ring the ticks are spokes: each points away from one centre, so
   * they take many directions and none of them is the same column.
   */
  it('stands the ticks around a circle at the player', () => {
    const lines = drawAt({ ratio: atRing, drawn: 1 }).lines;
    expect(lines).toHaveLength(ticks);
    // Every spoke starts on one circle: the same distance from the centre they
    // share, which for a full turn of them is their own centroid.
    const cx = lines.reduce((sum, line) => sum + line.x0, 0) / lines.length;
    const cy = lines.reduce((sum, line) => sum + line.y0, 0) / lines.length;
    const radii = lines.map(line => Math.hypot(line.x0 - cx, line.y0 - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.01);
    expect(Math.min(...radii)).toBeGreaterThan(1);
    // A spoke is not a column. At the ring, next to none of them are.
    const vertical = lines.filter(line => Math.abs(line.x1 - line.x0) < 0.01);
    expect(vertical.length).toBeLessThan(4);
  });

  /**
   * At the grain every tick is a column on one axis, symmetric about the
   * middle of the screen — which is what `drawGrain` has always drawn, and is
   * why the two can hand over without a seam.
   */
  it('opens them onto one time axis at the grain', () => {
    const lines = drawAt({ ratio: atGrain, drawn: 1 }).lines;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Math.abs(line.x1 - line.x0)).toBeLessThan(0.01);
      const midpoint = (line.y0 + line.y1) / 2;
      expect(Math.abs(midpoint - viewport.height / 2)).toBeLessThan(0.01);
    }
  });

  /**
   * And there are more of them by the time it gets there.
   *
   * The ticks span the whole song, so an axis closing on twelve seconds of a
   * two-minute one would keep about eight of them on screen. The count grows
   * with the spread instead, which holds the *screen* spacing still: the
   * measurement fills the axis it is opening onto rather than thinning across
   * it.
   */
  it('gains ticks as the axis closes, at a held screen spacing', () => {
    const spacingOf = (lines: Line[]) => {
      const xs = lines.map(line => line.x0).sort((a, b) => a - b);
      const gaps = xs.slice(1).map((x, i) => x - xs[i]).sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)];
    };
    const ring = drawAt({ ratio: atRing, drawn: 1 }).lines;
    const grain = drawAt({
      ratio: atGrain,
      drawn: 1,
      positionSeconds: middle,
    }).lines;

    expect(ring).toHaveLength(ticks);
    // Denser on screen, not merely spread further apart.
    expect(grain.length).toBeGreaterThan(ticks / 2);
    // The spacing the ring was drawn at is the spacing the axis keeps.
    expect(spacingOf(grain)).toBeCloseTo(viewport.width / ticks, 1);
  });

  /** And it is a crossing, not a cut: halfway is neither of the two poses. */
  it('is somewhere between the two at the middle of the crossing', () => {
    const between = drawAt({ ratio: (atRing + atGrain) / 2, drawn: 1 }).lines;
    const ring = drawAt({ ratio: atRing, drawn: 1 }).lines;
    const grain = drawAt({ ratio: atGrain, drawn: 1 }).lines;
    // Three o'clock rather than twelve: the tick at the top of the ring sits
    // on the centre line in both poses, so it is the one place the crossing
    // moves nothing and would prove nothing.
    const east = Math.floor(ticks / 4);
    expect(between[east].x0).not.toBeCloseTo(ring[east].x0, 1);
    expect(between[east].x0).not.toBeCloseTo(grain[east].x0, 1);
  });

  /**
   * The decoded detail resolves into the ticks rather than beside them: while
   * it is arriving both are drawn, and once it has the coarse pass is gone.
   */
  it('hands the ticks over to the decoded detail', () => {
    const arriving = drawAt({
      ratio: atGrain,
      drawn: 1,
      grain: centredBars,
      resolved: 0.5,
      positionSeconds: middle,
    });
    expect(arriving.lines.length).toBeGreaterThan(0);
    expect(arriving.rects).toHaveLength(32);

    const settled = drawAt({
      ratio: atGrain,
      drawn: 1,
      grain: centredBars,
      resolved: 1,
      positionSeconds: middle,
    });
    expect(settled.lines).toHaveLength(0);
    expect(settled.rects).toHaveLength(32);
  });

  /**
   * The detail is placed by the second it was decoded from, not by its index.
   *
   * That is what makes it *grow*. The decoded window is `ENTRY_SECONDS` wide
   * whatever the camera is doing, so while the axis still holds most of the
   * song it is a narrow dense band at the playhead, and it widens to fill the
   * screen as the axis closes on it. Placed by index it would have covered the
   * whole width from the first frame it existed, at the wrong scale, over
   * ticks that disagreed with it.
   */
  it('grows the detail out of the playhead as the axis closes', () => {
    const spanOf = (rects: Array<{ x: number; width: number }>) => {
      const lo = Math.min(...rects.map(r => r.x));
      const hi = Math.max(...rects.map(r => r.x + r.width));
      return hi - lo;
    };
    const crossing = drawAt({
      ratio: (atRing + atGrain) / 2,
      drawn: 1,
      grain: centredBars,
      resolved: 1,
      positionSeconds: middle,
    }).rects;
    const opened = drawAt({
      ratio: atGrain,
      drawn: 1,
      grain: centredBars,
      resolved: 1,
      positionSeconds: middle,
    }).rects;

    expect(crossing.length).toBeGreaterThan(0);
    // Narrow partway through, the full screen once the axis has closed.
    expect(spanOf(crossing)).toBeLessThan(spanOf(opened));
    // Within one column of the full width: each is drawn at 85% of its slot,
    // so the last gap is missing from the span.
    expect(spanOf(opened)).toBeGreaterThan(viewport.width - 32 / 2);
    expect(spanOf(opened)).toBeLessThanOrEqual(viewport.width);
    // And centred on the playhead at both, because that is the second the
    // camera is standing on.
    for (const rects of [crossing, opened]) {
      const lo = Math.min(...rects.map(r => r.x));
      const hi = Math.max(...rects.map(r => r.x + r.width));
      // Within a column of centre. Each is drawn at 85% of its slot, so the
      // right edge of the last one falls a fraction short of the extent.
      expect(Math.abs((lo + hi) / 2 - viewport.width / 2)).toBeLessThan(2);
    }
  });

  /**
   * The measurement stays drawn at the grain, where the song band has closed.
   *
   * Found on the phone: the draw-on clock was started by asking whether the
   * song band had finished opening, and a band closes at *both* ends. The
   * grain seat is far past its exit, so arriving at L3 reset the clock — the
   * ticks vanished at the moment they were needed, and took the decoded detail
   * with them, because it is drawn behind them.
   *
   * Reading the ratio instead is what fixes it, and these are the numbers that
   * make that reading correct: the latch closes before the L2 seat and nothing
   * further in reopens it.
   */
  it('latches past the song band, which the grain seat is beyond', () => {
    expect(
      bandAlphaAt(LEVEL_SCALE_RATIOS.grain, 1, REPRESENTATION_WINDOWS.song),
    ).toBe(0);
    const latch = REPRESENTATION_WINDOWS.song[1];
    expect(LEVEL_SCALE_RATIOS.song).toBeGreaterThanOrEqual(latch);
    expect(LEVEL_SCALE_RATIOS.grain).toBeGreaterThanOrEqual(latch);
    expect(GRAIN_KNOBS.ENTRY_RATIO).toBeGreaterThanOrEqual(latch);
  });

  /**
   * And the field gives way to the samples entirely once it opens.
   *
   * Also found on the phone. The row and the player are written against
   * arrivals rather than bands, and an arrival does not come back down — so at
   * the grain seat the row's action word and the player's name were still at
   * full ink over the waveform. The recorded picture had hidden that by
   * returning early after drawing the grain; the native path had to say it.
   */
  it('leaves nothing of the field standing at the grain seat', () => {
    const fieldFadeAt = (ratio: number) =>
      1 - bandAlphaAt(ratio, 1, REPRESENTATION_WINDOWS.grain);
    expect(fieldFadeAt(LEVEL_SCALE_RATIOS.grain)).toBe(0);
    // And nothing of the crossing is taken away before it begins.
    expect(fieldFadeAt(LEVEL_SCALE_RATIOS.song)).toBe(1);
    expect(fieldFadeAt(LEVEL_SCALE_RATIOS.shelf)).toBe(1);
  });
});


it('holds outgoing measurement ink until the camera has faded it away', () => {
  expect(songDetailPhase(30)).toBe('reveal');
  expect(songDetailPhase(26.99)).toBe('hold');
  expect(songDetailOpacity(26.99)).toBeGreaterThan(0.99);
  expect(drawAt({ ratio: 26.99, drawn: 1 }).lines).toHaveLength(ticks);
  expect(songDetailOpacity(20)).toBeLessThan(1);
  expect(songDetailOpacity(20)).toBeGreaterThan(0);
  expect(songDetailPhase(12)).toBe('hidden');
  expect(drawAt({ ratio: 12, drawn: 1 }).lines).toHaveLength(0);
  expect(songDetailPhase(atGrain)).toBe('reveal');
  expect(songDetailOpacity(atGrain)).toBe(1);
});
