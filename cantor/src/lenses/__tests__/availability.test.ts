import { PaintStyle, Skia } from '@shopify/react-native-skia';
import { fitText } from '../nameLens';
import {
  ARRIVING_NONE,
  ARRIVING_UNKNOWN,
  FACE_FILL_ALPHA,
  LENSES,
  FACE_STROKE_ALPHA,
  arrivedShare,
  arrivingFraction,
  arrivingHeld,
  isArrivingHeld,
  availabilityAction,
  availabilityLine,
  availabilityOf,
  formatBytes,
  nameLens,
  neutralAnalysis,
  type Lens,
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
    expect(availabilityLine(song({ audioState: 'remote' }))).toBe('ON STUDIO');
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
 * alike, and every lens keeps the circle's reading in its own form — on the
 * node lightest, cached firmer, downloaded heaviest, and a download visibly
 * landing. Weight is not a number in a table until it reaches pixels, so this
 * draws the marks through each lens's `drawMark` — what the field calls — and
 * measures how much ink each puts down.
 *
 * The ring round the playing song is the renderer's, not a lens's
 * (`fieldFaces.test`).
 */
describe('the four marks are four different marks', () => {
  const SIZE = 64;

  function paints() {
    const make = (color: string) => {
      const value = Skia.Paint();
      value.setAntiAlias(true);
      value.setColor(Skia.Color(color));
      return value;
    };
    const stroke = make('#000000');
    stroke.setStyle(PaintStyle.Stroke);
    return { fill: make('#000000'), stroke };
  }

  /** Every pixel's darkness against white paper, summed: ink laid down. */
  function ink(
    lens: Lens,
    state: LensSong['audioState'],
    arriving: number = ARRIVING_NONE,
  ): number {
    const surface = Skia.Surface.Make(SIZE, SIZE);
    if (surface === null) throw new Error('no surface');
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('#FFFFFF'));
    canvas.translate(SIZE / 2, SIZE / 2);
    const availability = availabilityOf(state);
    lens.ui.drawMark(
      canvas,
      lens.identity({
        seed: 41822,
        id: 'song-a',
        model: 'acestep:1.5-fast',
        durationMs: 141_000,
      }),
      1,
      1,
      FACE_STROKE_ALPHA[availability],
      FACE_FILL_ALPHA[availability],
      0,
      arriving,
      1,
      paints(),
    );
    surface.flush();
    const pixels = surface.makeImageSnapshot().readPixels();
    if (pixels === null) throw new Error('no pixels');
    let total = 0;
    for (let index = 0; index < SIZE * SIZE; index += 1) {
      total += 255 - (pixels[index * 4] as number);
    }
    return total;
  }

  it('draws more of the circle the stronger the promise', () => {
    const notSynced = ink(nameLens, 'remote');
    const cached = ink(nameLens, 'cached');
    const downloaded = ink(nameLens, 'pinned');

    expect(notSynced).toBeGreaterThan(0);
    expect(cached).toBeGreaterThan(notSynced * 1.5);
    // Filled, not merely firmer: a full face is several times its own outline.
    expect(downloaded).toBeGreaterThan(cached * 2);
  });

  /**
   * The seal failed this before R7: its filled dots were smaller than the
   * hairline rings of a cached seal, so a downloaded seal read lighter than a
   * cached one and about as light as one not on the phone.
   */
  it('draws more of every lens the stronger the promise', () => {
    for (const lens of LENSES) {
      const notSynced = ink(lens, 'remote');
      const cached = ink(lens, 'cached');
      const downloaded = ink(lens, 'pinned');
      expect(notSynced).toBeGreaterThan(0);
      expect(cached).toBeGreaterThan(notSynced * 1.5);
      expect(downloaded).toBeGreaterThan(cached * 1.3);
    }
  });

  it('shows a download landing, as far as the bytes have come, in every lens', () => {
    for (const lens of LENSES) {
      const waiting = ink(lens, 'remote');
      const early = ink(lens, 'partial', 0.15);
      const late = ink(lens, 'partial', 0.9);
      const unknown = ink(lens, 'partial', ARRIVING_UNKNOWN);
      expect(early).toBeGreaterThan(waiting);
      expect(late).toBeGreaterThan(early);
      // An unknown total is a fixed share, not a claim: never nearly done.
      expect(unknown).toBeGreaterThan(waiting);
      expect(unknown).toBeLessThan(late);
    }
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

describe('a download that is not simply landing', () => {
  const song = {
    audioState: 'partial' as const,
    arriving: 0.46,
    byteLength: 1000,
    nodeLabel: 'agentbox',
  };
  it('says where it stopped, what it waits for, and what changed', () => {
    expect(availabilityLine(song, 'held')).toBe(
      'STOPPED AT 46% · AGENTBOX LEFT',
    );
    expect(availabilityLine(song, 'stopped')).toBe('STOPPED AT 46%');
    expect(
      availabilityLine(
        { ...song, audioState: 'remote', arriving: null },
        'waiting',
      ),
    ).toBe('WAITING FOR AGENTBOX');
    expect(availabilityLine(song, 'changed')).toBe(
      'THE FILE CHANGED ON AGENTBOX',
    );
    expect(availabilityLine(song, 'moving')).toBe('DOWNLOADING · 46%');
  });
  it('offers only what can be done about it', () => {
    expect(availabilityAction('not-synced', 'waiting')).toBe('CANCEL');
    expect(availabilityAction('arriving', 'changed')).toBe('START AGAIN');
    expect(availabilityAction('arriving', 'stopped')).toBe('GET');
    expect(availabilityAction('arriving', 'held')).toBeNull();
    expect(availabilityAction('arriving', 'moving')).toBeNull();
  });
  it('draws a stopped download where it stopped, apart from a moving one', () => {
    const held = arrivingHeld(0.46);
    expect(isArrivingHeld(held)).toBe(true);
    expect(arrivedShare(held)).toBeCloseTo(0.46);
    expect(isArrivingHeld(0.46)).toBe(false);
  });
});
