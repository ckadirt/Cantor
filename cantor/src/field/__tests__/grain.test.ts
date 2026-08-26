import {
  GRAIN_KNOBS,
  centerForFocalZoom,
  columnsFor,
  grainWindow,
  scaleForVisibleSeconds,
  timeAtFraction,
  visibleSecondsAt,
} from '../grain';

const FIT = 4;

describe('visibleSecondsAt', () => {
  it('shows the entry span at the moment L3 begins', () => {
    expect(visibleSecondsAt(FIT * GRAIN_KNOBS.ENTRY_RATIO, FIT)).toBeCloseTo(
      GRAIN_KNOBS.ENTRY_SECONDS,
      10,
    );
  });

  it('halves the visible span for every doubling of scale', () => {
    const entry = FIT * GRAIN_KNOBS.ENTRY_RATIO;

    expect(visibleSecondsAt(entry * 2, FIT)).toBeCloseTo(
      GRAIN_KNOBS.ENTRY_SECONDS / 2,
      10,
    );
    expect(visibleSecondsAt(entry * 4, FIT)).toBeCloseTo(
      GRAIN_KNOBS.ENTRY_SECONDS / 4,
      10,
    );
  });

  it('never shows more than the entry span, however far out the camera is', () => {
    expect(visibleSecondsAt(FIT, FIT)).toBe(GRAIN_KNOBS.ENTRY_SECONDS);
    expect(visibleSecondsAt(FIT * 0.001, FIT)).toBe(GRAIN_KNOBS.ENTRY_SECONDS);
  });

  it('clamps at the closest look rather than resolving noise', () => {
    expect(visibleSecondsAt(FIT * 1e12, FIT)).toBe(GRAIN_KNOBS.MIN_SECONDS);
  });

  it('round-trips through the scale that produces it', () => {
    for (const seconds of [0.05, 0.5, 2, 12]) {
      const scale = scaleForVisibleSeconds(seconds, FIT);
      expect(visibleSecondsAt(scale, FIT)).toBeCloseTo(seconds, 9);
    }
  });

  it('refuses a nonsense scale rather than producing a nonsense window', () => {
    expect(() => visibleSecondsAt(0, FIT)).toThrow('positive');
    expect(() => visibleSecondsAt(FIT, 0)).toThrow('positive');
  });
});

describe('grainWindow', () => {
  it('centres on the requested moment in the middle of a song', () => {
    const window = grainWindow(60, 10, 141);

    expect(window.startSeconds).toBeCloseTo(55, 10);
    expect(window.endSeconds).toBeCloseTo(65, 10);
    expect(window.visibleSeconds).toBeCloseTo(10, 10);
  });

  it('slides rather than shrinks at the start of a track', () => {
    const window = grainWindow(1, 10, 141);

    expect(window.startSeconds).toBe(0);
    // The span the scale asked for is preserved; only the centre moves.
    expect(window.visibleSeconds).toBeCloseTo(10, 10);
  });

  it('slides rather than shrinks at the end of a track', () => {
    const window = grainWindow(140, 10, 141);

    expect(window.endSeconds).toBeCloseTo(141, 10);
    expect(window.visibleSeconds).toBeCloseTo(10, 10);
  });

  it('shows the whole of a song shorter than the window', () => {
    const window = grainWindow(3, 30, 8);

    expect(window.startSeconds).toBe(0);
    expect(window.endSeconds).toBeCloseTo(8, 10);
  });

  it('keeps the centre inside the track however far it is asked to go', () => {
    expect(grainWindow(-50, 10, 141).centerSeconds).toBe(0);
    expect(grainWindow(9999, 10, 141).centerSeconds).toBe(141);
  });

  it('survives a song with no duration yet', () => {
    const window = grainWindow(0, 10, 0);

    expect(window.startSeconds).toBe(0);
    expect(Number.isFinite(window.endSeconds)).toBe(true);
  });
});

describe('centerForFocalZoom', () => {
  it('keeps the timestamp under the fingers when zooming in', () => {
    // Fingers a quarter across, on 40s: after zooming, 40s must still be a
    // quarter across the new window.
    const center = centerForFocalZoom(40, 0.25, 4);
    const window = grainWindow(center, 4, 141);

    expect(timeAtFraction(window, 0.25)).toBeCloseTo(40, 9);
  });

  it('keeps a centred point centred', () => {
    expect(centerForFocalZoom(40, 0.5, 4)).toBeCloseTo(40, 10);
  });

  it('keeps the timestamp stable at either edge of the window', () => {
    for (const fraction of [0, 1]) {
      const center = centerForFocalZoom(40, fraction, 6);
      const window = grainWindow(center, 6, 141);
      expect(timeAtFraction(window, fraction)).toBeCloseTo(40, 9);
    }
  });

  it('clamps a focal fraction that came from outside the view', () => {
    expect(centerForFocalZoom(40, -3, 4)).toBeCloseTo(
      centerForFocalZoom(40, 0, 4),
      10,
    );
  });
});

describe('columnsFor', () => {
  it('asks for about one column per pixel', () => {
    expect(columnsFor(380)).toBe(380);
  });

  it('stays inside its bounds for absurd viewports', () => {
    expect(columnsFor(1)).toBe(GRAIN_KNOBS.MIN_COLUMNS);
    expect(columnsFor(100_000)).toBe(GRAIN_KNOBS.MAX_COLUMNS);
    expect(columnsFor(Number.NaN)).toBe(GRAIN_KNOBS.MIN_COLUMNS);
  });
});

describe('timeAtFraction', () => {
  it('maps the window edges to its own bounds', () => {
    const window = grainWindow(60, 10, 141);

    expect(timeAtFraction(window, 0)).toBeCloseTo(window.startSeconds, 10);
    expect(timeAtFraction(window, 1)).toBeCloseTo(window.endSeconds, 10);
    expect(timeAtFraction(window, 0.5)).toBeCloseTo(60, 10);
  });
});
