import { PaintStyle, Skia } from '@shopify/react-native-skia';
import { FACE_MAX_EXTENT } from '../face';
import { fitText } from '../nameLens';
import {
  arrivingFraction,
  availabilityAction,
  availabilityLine,
  availabilityOf,
  formatBytes,
  nameLens,
  neutralAnalysis,
  type LensPaints,
  type LensSong,
} from '..';

function song(overrides: Partial<LensSong> = {}): LensSong {
  return {
    key: 'node-a:song-a',
    id: 'song-a',
    seed: 41822,
    title: 'A song',
    createdAtMs: Date.parse('2026-08-10T00:00:00Z'),
    durationMs: 141_000,
    model: 'acestep:1.5-fast',
    nodeLabel: 'Studio',
    audioState: 'remote',
    arriving: null,
    byteLength: 3_400_000,
    playing: false,
    analysis: neutralAnalysis(),
    progress: null,
    ...overrides,
  };
}

describe('what a song promises about its audio', () => {
  it('reads the four marks off the local audio state', () => {
    expect(availabilityOf('remote')).toBe('not-synced');
    expect(availabilityOf('partial')).toBe('arriving');
    expect(availabilityOf('cached')).toBe('cached');
    expect(availabilityOf('pinned')).toBe('downloaded');
  });

  it('measures arrival as a fraction of the artifact', () => {
    expect(arrivingFraction(0, 1000)).toBe(0);
    expect(arrivingFraction(250, 1000)).toBe(0.25);
    expect(arrivingFraction(1000, 1000)).toBe(1);
  });

  it('refuses to invent progress it cannot know', () => {
    expect(arrivingFraction(120, undefined)).toBeNull();
    expect(arrivingFraction(120, 0)).toBeNull();
    expect(arrivingFraction(Number.NaN, 1000)).toBeNull();
  });

  it('clamps a node that reports more bytes than it promised', () => {
    expect(arrivingFraction(2000, 1000)).toBe(1);
    expect(arrivingFraction(-10, 1000)).toBe(0);
  });
});

describe('what a row says and offers', () => {
  it('offers the one action the state allows', () => {
    expect(availabilityAction('not-synced')).toBe('GET');
    expect(availabilityAction('cached')).toBe('KEEP');
    expect(availabilityAction('downloaded')).toBe('REMOVE');
    // Nothing to offer while the bytes are already on their way.
    expect(availabilityAction('arriving')).toBeNull();
  });

  it('says where the audio is, in the words the design uses', () => {
    expect(availabilityLine(song({ audioState: 'remote' }))).toBe(
      'ON STUDIO',
    );
    expect(availabilityLine(song({ audioState: 'cached' }))).toBe(
      'CACHED · MAY BE RECLAIMED',
    );
    expect(
      availabilityLine(song({ audioState: 'pinned', byteLength: 3_400_000 })),
    ).toBe('DOWNLOADED · 3.2 MB');
    expect(
      availabilityLine(song({ audioState: 'partial', arriving: 0.423 })),
    ).toBe('DOWNLOADING · 42%');
  });

  it('says less rather than something false when the node offered no size', () => {
    expect(
      availabilityLine(song({ audioState: 'pinned', byteLength: null })),
    ).toBe('DOWNLOADED');
    expect(
      availabilityLine(song({ audioState: 'partial', arriving: null })),
    ).toBe('DOWNLOADING');
  });

  it('says bytes the way a person would', () => {
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(3_400_000)).toBe('3.2 MB');
    expect(formatBytes(34 * 1024 * 1024)).toBe('34 MB');
    expect(formatBytes(1.4 * 1024 ** 3)).toBe('1.4 GB');
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(Number.NaN)).toBe('0 KB');
  });
});

/**
 * The design's one non-negotiable here: cached and downloaded must never look
 * alike. Weight is not a number in a table until it reaches pixels, so this
 * draws the four marks and measures how much ink each one puts down.
 */
describe('the four marks are four different marks', () => {
  const SIZE = 64;
  const CENTRE = SIZE / 2;
  /** Radius the mark's face is drawn at; its lobes reach `FACE_MAX_EXTENT` of it. */
  const FACE_RADIUS_PX = 7.5;
  /** Clear of the furthest lobe and its antialiasing: only a ring reaches here. */
  const OUTSIDE_THE_FACE_PX = FACE_RADIUS_PX * FACE_MAX_EXTENT + 1;

  function paints(): LensPaints {
    const make = (color: string) => {
      const value = Skia.Paint();
      value.setAntiAlias(true);
      value.setColor(Skia.Color(color));
      return value;
    };
    const outline = make('#000000');
    outline.setStyle(PaintStyle.Stroke);
    outline.setStrokeWidth(1);
    return {
      ink: make('#000000'),
      muted: make('#666666'),
      faint: make('#A6A6A6'),
      outline,
    };
  }

  /** Every pixel's darkness against white paper, summed; ink laid down. */
  function draw(value: LensSong): { total: number; ring: number } {
    const surface = Skia.Surface.Make(SIZE, SIZE);
    if (surface === null) throw new Error('no surface');
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('#FFFFFF'));
    nameLens.draw(
      canvas,
      { kind: 'mark', x: CENTRE, y: CENTRE, width: 0, height: 0 },
      value,
      {
        alpha: 1,
        fonts: {
          display: Skia.Font(undefined, 20),
          body: Skia.Font(undefined, 20),
          mono: Skia.Font(undefined, 9),
        },
        paints: paints(),
      },
    );
    surface.flush();
    const pixels = surface.makeImageSnapshot().readPixels();
    if (pixels === null) throw new Error('no pixels');
    let total = 0;
    let ring = 0;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const darkness = 255 - (pixels[(y * SIZE + x) * 4] as number);
        total += darkness;
        // Outside the face's own lobes, where only a ring can reach.
        const distance = Math.hypot(x - CENTRE, y - CENTRE);
        if (distance > OUTSIDE_THE_FACE_PX) ring += darkness;
      }
    }
    return { total, ring };
  }

  it('draws more of the face the stronger the promise', () => {
    const notSynced = draw(song({ audioState: 'remote' })).total;
    const cached = draw(song({ audioState: 'cached' })).total;
    const downloaded = draw(song({ audioState: 'pinned' })).total;

    expect(notSynced).toBeGreaterThan(0);
    expect(cached).toBeGreaterThan(notSynced * 1.5);
    // Filled, not merely firmer: a full face is several times its own outline.
    expect(downloaded).toBeGreaterThan(cached * 2);
  });

  it('puts a ring around a song that is arriving, and none around one that is here', () => {
    const arriving = draw(song({ audioState: 'partial', arriving: 0.5 }));
    const cached = draw(song({ audioState: 'cached' }));

    expect(cached.ring).toBe(0);
    expect(arriving.ring).toBeGreaterThan(0);
  });

  it('draws the arc as far as the bytes have come', () => {
    const early = draw(song({ audioState: 'partial', arriving: 0.15 })).ring;
    const late = draw(song({ audioState: 'partial', arriving: 0.9 })).ring;
    const unknown = draw(song({ audioState: 'partial', arriving: null })).ring;

    expect(late).toBeGreaterThan(early * 2);
    // An unknown total is a sweep, not a claim: shorter than a nearly-finished
    // download and never a full circle.
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThan(late);
  });

  it('keeps the playing ring off the face it belongs to', () => {
    const playing = draw(song({ audioState: 'cached', playing: true }));

    expect(playing.ring).toBeGreaterThan(0);
  });
});

/**
 * Tap descends and the word at the end acts, so the title has to stop before
 * the word does. The Skia jest mock has no typeface — it measures nothing and
 * draws no glyphs — so the cut is tested against a font whose widths are known
 * and the drawn result is checked on the device.
 */
describe('cutting a title to the column it has', () => {
  /** A font where every character is exactly seven wide. */
  const font = {
    getSize: () => 15,
    measureText: (text: string) => ({ width: text.length * 7 }),
  };

  it('leaves a title that already fits exactly as it is', () => {
    expect(fitText('Lanterns', font, 200)).toBe('Lanterns');
  });

  it('cuts to the widest prefix that fits, and says it was cut', () => {
    // 10 characters of room: nine of the title and the ellipsis.
    const cut = fitText('Distant Signal', font, 70);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length * 7).toBeLessThanOrEqual(70);
    expect(fitText('Distant Signal', font, 77).length).toBeGreaterThan(
      cut.length,
    );
  });

  it('never returns more than it was asked for, at any width', () => {
    const title = 'A title far longer than any row could hope to hold';
    for (let width = 0; width <= 400; width += 7) {
      expect(fitText(title, font, width).length * 7).toBeLessThanOrEqual(
        Math.max(width, 0),
      );
    }
  });

  it('gives up rather than drawing an ellipsis alone', () => {
    expect(fitText('Lanterns', font, 6)).toBe('');
    expect(fitText('Lanterns', font, 0)).toBe('');
    expect(fitText('Lanterns', font, -10)).toBe('');
  });
});
