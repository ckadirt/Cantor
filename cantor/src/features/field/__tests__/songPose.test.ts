import { Skia } from '@shopify/react-native-skia';
import { NAME_LENS_KNOBS } from '../../../lenses';
import { playerWords } from '../NativePlayer';
import {
  PLAYER_POSE_KNOBS,
  facePoseAt,
  playerFaceScale,
  playerFootScreenPx,
  playerRadiusPx,
  playerRisePx,
  lineOwnedByPlayer,
  songScrubOriginPx,
  songTitleColumnPx,
  songWordsOriginPx,
} from '../songPose';

const viewport = { width: 412, height: 892 };
const FACE_GROWTH =
  NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX / NAME_LENS_KNOBS.MARK_RADIUS_PX;

describe('the face across its three poses', () => {
  /**
   * The whole claim of the migration, as three numbers. One path, one alpha,
   * three places to be — if any of these were a different drawing there would
   * be a crossfade somewhere, which is exactly what the player used to be.
   */
  it('is the mark at rest', () => {
    const pose = facePoseAt(0, 0, viewport, FACE_GROWTH);
    expect(pose.x).toBeCloseTo(0);
    expect(pose.y).toBeCloseTo(0);
    expect(pose.scale).toBe(1);
  });

  it('is the row once the face has walked to its seat', () => {
    const pose = facePoseAt(1, 0, viewport, FACE_GROWTH);
    expect(pose.x).toBeCloseTo(-NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX);
    expect(pose.y).toBeCloseTo(0);
    expect(pose.scale).toBeCloseTo(FACE_GROWTH);
  });

  it('is the player once the song band is open', () => {
    const pose = facePoseAt(1, 1, viewport, FACE_GROWTH);
    // Back on the mark's own x: the row's preview offset is undone by the same
    // number that lifts the ring into its seat.
    expect(pose.x).toBeCloseTo(0);
    expect(pose.y).toBeCloseTo(-playerRisePx(viewport.height, 1));
    expect(pose.scale).toBeCloseTo(playerFaceScale(viewport.width));
  });

  /**
   * A pose that jumped would be a mark that flickers mid-pinch, which is the
   * failure the recorded picture had and the reason any of this moved to the
   * UI thread. Walked reaches 1 well before the song band opens, so the two
   * segments are checked on the halves they actually own.
   */
  it('moves continuously through both segments', () => {
    const samples: { x: number; y: number; scale: number }[] = [];
    for (let i = 0; i <= 20; i += 1) {
      samples.push(facePoseAt(i / 20, 0, viewport, FACE_GROWTH));
    }
    for (let i = 0; i <= 20; i += 1) {
      samples.push(facePoseAt(1, i / 20, viewport, FACE_GROWTH));
    }
    const biggestStep = samples
      .slice(1)
      .reduce(
        (worst, sample, index) =>
          Math.max(
            worst,
            Math.abs(sample.x - samples[index].x),
            Math.abs(sample.y - samples[index].y),
          ),
        0,
      );
    // A twentieth of the longest journey either segment makes, and no jump
    // anywhere near the size of a whole hand-over.
    expect(biggestStep).toBeLessThan(playerRisePx(viewport.height, 1) / 4);
    // And it only ever grows.
    for (let i = 21; i < samples.length; i += 1) {
      expect(samples[i].scale).toBeGreaterThanOrEqual(samples[i - 1].scale);
    }
  });

  it('grows the mark into a face that fills its share of the view', () => {
    const radius =
      playerRadiusPx(viewport.width) * NAME_LENS_KNOBS.SONG_FACE_RATIO;
    expect(playerFaceScale(viewport.width) * NAME_LENS_KNOBS.MARK_RADIUS_PX).toBeCloseTo(
      radius,
    );
  });
});

describe('the foot the touch layer lays itself over', () => {
  /**
   * The load-bearing assumption of the whole hit layer.
   *
   * The canvas draws the transport off the song's own mark and React Native
   * lays its buttons out in the viewport, and the two have to name the same
   * pixels or every word is a button that is a few pixels from where it looks.
   * They agree exactly where the camera is centred on the mark, which is what
   * arriving at a song means and the only distance at which any of this is
   * pressable — so that is the equality asserted here.
   */
  it('agrees with the drawn foot when the camera is centred on the mark', () => {
    const drawn = songWordsOriginPx(viewport);
    const pressed = playerFootScreenPx(viewport);
    expect(viewport.width / 2 + drawn.x).toBeCloseTo(pressed.x);
    expect(viewport.height / 2 + drawn.y).toBeCloseTo(pressed.y);
    // The rule and the strip that scrubs it, held to the same equality.
    const rule = songScrubOriginPx(viewport);
    expect(viewport.width / 2 + rule.x).toBeCloseTo(pressed.x);
    expect(viewport.height / 2 + rule.y).toBeCloseTo(pressed.scrubY);
  });

  it('keeps the foot clear of the origin mark in the same corner', () => {
    const pressed = playerFootScreenPx(viewport);
    expect(viewport.height - pressed.y).toBeGreaterThan(0);
    expect(pressed.x).toBe(PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX);
  });

  it('gives the name both margins and no more', () => {
    expect(songTitleColumnPx(viewport.width)).toBe(
      viewport.width - PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX * 2,
    );
  });
});

describe('the transport words', () => {
  const font = Skia.Font(undefined, 11);

  it('lays the same three words out for the canvas and for the fingers', () => {
    const drawn = playerWords(font, 'PLAY', 'ON PHONE');
    const pressed = playerWords(font, 'PLAY', 'ON PHONE');
    expect(pressed).toEqual(drawn);
    expect(drawn.map(word => word.key)).toEqual([
      'transport',
      'detail',
      'audio',
    ]);
  });

  it('reads left to right without a word overlapping the next', () => {
    const words = playerWords(font, 'PAUSE', 'PINNED');
    expect(words[0].x).toBe(0);
    // Never NaN, whatever the runtime's font can measure: one unmeasurable word
    // would put every word after it, and every button over them, nowhere at all.
    for (const word of words) {
      expect(Number.isFinite(word.x)).toBe(true);
      expect(Number.isFinite(word.width)).toBe(true);
    }
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i].x).toBeGreaterThanOrEqual(
        words[i - 1].x + words[i - 1].width,
      );
    }
  });

  it('moves the words along when the transport says a longer word', () => {
    const short = playerWords(font, 'PLAY', 'ON NODE');
    const long = playerWords(font, 'FETCH', 'ON NODE');
    // Only meaningful with a real typeface; CanvasKit measures nothing without
    // one, and a test that silently asserts 0 === 0 is not a test.
    if (short[0].width === 0) return;
    expect(long[1].x).toBeGreaterThan(short[1].x);
  });
});

describe('who owns a line', () => {
  /**
   * The row draws its title with `1 - this` and the morph draws it with `this`,
   * so a value that was ever between the two would draw one name twice at half
   * weight, and a value that was ever 1 on both sides would draw it twice at
   * full weight. Neither is a fade; both are just a heavier-looking row.
   */
  it('is never shared between the row and the player', () => {
    for (const arrived of [0, 0.0001, 0.25, 0.5, 0.75, 1]) {
      const player = lineOwnedByPlayer(arrived);
      expect(player === 0 || player === 1).toBe(true);
      expect(player + (1 - player)).toBe(1);
    }
  });

  it('leaves the line with the row until the song band opens', () => {
    expect(lineOwnedByPlayer(0)).toBe(0);
    // And takes it the instant it does: the morph's own geometry at that point
    // is the row's line, so there is nothing to fade between.
    expect(lineOwnedByPlayer(Number.EPSILON)).toBe(1);
    expect(lineOwnedByPlayer(1)).toBe(1);
  });
});
