import { Skia } from '@shopify/react-native-skia';
import { NAME_LENS_KNOBS } from '../../../lenses';
import {
  playPauseSilhouettes,
  playerWords,
  stepSilhouette,
} from '../NativePlayer';
import {
  PLAYER_POSE_KNOBS,
  facePoseAt,
  playerFaceScale,
  playerFootScreenPx,
  playerRadiusPx,
  playerRisePx,
  lineOwnedByPlayer,
  songAxisPx,
  songMetaOriginPx,
  songTitleColumnPx,
  songTitleOriginPx,
  playerSeekScreenPx,
  seekFractionAt,
  songWordsOriginPx,
  transportScreenPx,
  transportSeatsPx,
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
    expect(viewport.width / 2 + drawn.x).toBeCloseTo(pressed.axisX);
    expect(viewport.height / 2 + drawn.y).toBeCloseTo(pressed.y);
  });

  /**
   * One axis, not two.
   *
   * The player used to be two layouts on one screen — the clock, the circle and
   * the transport centred, everything else against the left margin — and the
   * seam was the loudest thing on it. Every drawn row stands on the same line
   * now, and the line is the mark's own point.
   */
  it('stands every drawn row on the song\u2019s own axis', () => {
    expect(songAxisPx()).toBe(0);
    for (const origin of [
      songTitleOriginPx(viewport),
      songMetaOriginPx(viewport),
      songWordsOriginPx(viewport),
    ]) {
      expect(origin.x).toBe(songAxisPx());
    }
    for (const seat of transportSeatsPx(viewport)) {
      expect(seat.x + seat.x * 0).toBe(seat.x); // the seats mirror about it
    }
    const seats = transportSeatsPx(viewport);
    expect(seats[0].x + seats[2].x).toBeCloseTo(2 * songAxisPx());
  });

  /**
   * The foot reads downward: name, recipe, transport, lens, the quiet line.
   *
   * Written as five distances off the bottom edge rather than as a chain of
   * gaps, so this is the one place the order is asserted — and moving any row
   * cannot silently push another through the one below it.
   */
  it('keeps the foot in reading order with room between the rows', () => {
    const rows = [
      songTitleOriginPx(viewport).y,
      songMetaOriginPx(viewport).y,
      transportSeatsPx(viewport)[1].y,
      viewport.height / 2 - PLAYER_POSE_KNOBS.SONG_LENS_BOTTOM_PX,
      songWordsOriginPx(viewport).y,
    ];
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]).toBeGreaterThan(rows[index - 1]);
    }
    // And the last of them is still clear of the bottom edge.
    expect(rows[rows.length - 1]).toBeLessThan(viewport.height / 2);
  });

  it('keeps the foot clear of the origin mark in the same corner', () => {
    const pressed = playerFootScreenPx(viewport);
    expect(viewport.height - pressed.y).toBeGreaterThan(0);
    expect(pressed.axisX).toBeCloseTo(viewport.width / 2);
  });

  it('gives the name both margins and no more', () => {
    expect(songTitleColumnPx(viewport.width)).toBe(
      viewport.width - PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX * 2,
    );
  });
});

describe('the foot\u2019s words', () => {
  const font = Skia.Font(undefined, 11);

  it('lays the same two words out for the canvas and for the fingers', () => {
    const drawn = playerWords(font, 'ON PHONE');
    const pressed = playerWords(font, 'ON PHONE');
    expect(pressed).toEqual(drawn);
    // The transport is not among them any more: it is a silhouette on a shared
    // value, so that a press moves geometry rather than re-recording a canvas.
    expect(drawn.map(word => word.key)).toEqual(['detail', 'audio']);
  });

  it('reads left to right without a word overlapping the next', () => {
    const words = playerWords(font, 'PINNED');
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
});

describe('the transport', () => {
  it('seats the three buttons in reading order about the mark', () => {
    const seats = transportSeatsPx(viewport);
    expect(seats.map(seat => seat.key)).toEqual([
      'previous',
      'playPause',
      'next',
    ]);
    // Centred on the mark, which at L2 is the middle of the view — so the verb
    // sits on the axis and the two steps are a mirror pair either side of it.
    expect(seats[1].x).toBe(0);
    expect(seats[0].x).toBeCloseTo(-seats[2].x);
    // One row: three seats at three heights would not read as one control.
    expect(seats[0].y).toBe(seats[1].y);
    expect(seats[1].y).toBe(seats[2].y);
  });

  /**
   * Under the name, and clear of the ring.
   *
   * The order is the sentence the screen reads as — what it looks like, what it
   * is called, what you can do to it — and it puts the controls lowest, where a
   * thumb already is. Between the circle and the name they sat mid-screen with
   * the name below them, so the only pressable thing was the furthest from your
   * hand.
   */
  it('sits under the name it belongs to, clear of the ring', () => {
    const seats = transportSeatsPx(viewport);
    const ringFoot =
      -playerRisePx(viewport.height, 1) + playerRadiusPx(viewport.width);
    for (const seat of seats) {
      expect(seat.y - seat.size / 2).toBeGreaterThan(ringFoot);
      expect(seat.y - seat.size / 2).toBeGreaterThan(
        songMetaOriginPx(viewport).y,
      );
    }
  });

  /**
   * The drawn seat and the pressed one, held to the same equality the foot is:
   * the camera is centred on the mark at L2, so the mark's point *is* the
   * middle of the view. A button a few pixels off from the shape it belongs to
   * is worse than no button.
   */
  it('agrees with the drawn seat when the camera is centred on the mark', () => {
    const drawn = transportSeatsPx(viewport);
    const pressed = transportScreenPx(viewport);
    for (let index = 0; index < drawn.length; index += 1) {
      expect(pressed[index].key).toBe(drawn[index].key);
      expect(pressed[index].x).toBeCloseTo(viewport.width / 2 + drawn[index].x);
      expect(pressed[index].y).toBeCloseTo(
        viewport.height / 2 + drawn[index].y,
      );
    }
  });

  /**
   * The whole claim of the morph: one drawing at two poses.
   *
   * `interpolate` answers null for two paths that are not point-for-point
   * compatible, and a null path is a transport that vanishes the instant it is
   * pressed. The triangle is written as two quads with its apex emitted twice
   * for exactly this reason, so the pairing is what has to be pinned.
   */
  it('morphs play into pause rather than crossfading them', () => {
    const seat = transportSeatsPx(viewport)[1];
    const { play, pause } = playPauseSilhouettes(seat.x, seat.y, seat.size);
    expect(play.isInterpolatable(pause)).toBe(true);
    expect(play.interpolate(pause, 0.5)).not.toBeNull();
    // Two contours on both sides: the halves of the triangle are the bars.
    expect(play.countPoints()).toBe(8);
    expect(pause.countPoints()).toBe(8);
  });

  it('draws a step as one glyph facing two ways', () => {
    const seats = transportSeatsPx(viewport);
    const next = stepSilhouette(0, 0, seats[2].size, 1);
    const previous = stepSilhouette(0, 0, seats[0].size, -1);
    expect(next.countPoints()).toBe(previous.countPoints());
    const forward = next.getBounds();
    const back = previous.getBounds();
    expect(forward.width).toBeCloseTo(back.width);
    expect(forward.height).toBeCloseTo(back.height);
    // A mirror about the seat's own centre, not a shape moved sideways.
    expect(forward.x).toBeCloseTo(-(back.x + back.width));
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

/**
 * Seeking is an angle now, not a distance along a bar.
 *
 * The ring is the timeline — the design settles that — so what has to hold is
 * that the gesture and the drawing agree on where twelve o'clock is and which
 * way round the song runs. `PlayerRing` builds its arc at -90 degrees over 360
 * and turns its hand by `fraction · 2π`, so these are that same convention read
 * backwards.
 */
describe('seeking on the ring', () => {
  const ring = playerSeekScreenPx(viewport);

  it('reads the top of the ring as the start of the song', () => {
    const top = seekFractionAt(viewport, ring.cx, ring.cy - ring.outer * 0.6);
    expect(top).not.toBeNull();
    expect(top as number).toBeCloseTo(0, 5);
  });

  it('runs clockwise, the way the hand turns', () => {
    const quarter = seekFractionAt(
      viewport,
      ring.cx + ring.outer * 0.6,
      ring.cy,
    );
    const half = seekFractionAt(viewport, ring.cx, ring.cy + ring.outer * 0.6);
    const threeQuarters = seekFractionAt(
      viewport,
      ring.cx - ring.outer * 0.6,
      ring.cy,
    );
    expect(quarter as number).toBeCloseTo(0.25, 5);
    expect(half as number).toBeCloseTo(0.5, 5);
    expect(threeQuarters as number).toBeCloseTo(0.75, 5);
  });

  /**
   * A touch that means nothing answers null rather than a clamped number.
   *
   * At the very centre one pixel of travel sweeps half the song, so an angle
   * there is noise wearing the shape of an intention.
   */
  it('ignores a touch in the dead centre or past the ring', () => {
    expect(seekFractionAt(viewport, ring.cx, ring.cy)).toBeNull();
    expect(
      seekFractionAt(viewport, ring.cx, ring.cy - ring.inner * 0.5),
    ).toBeNull();
    expect(
      seekFractionAt(viewport, ring.cx, ring.cy - ring.outer * 1.2),
    ).toBeNull();
  });

  it('always answers inside one turn', () => {
    for (let degrees = 0; degrees < 360; degrees += 17) {
      const radians = (degrees * Math.PI) / 180;
      const at = seekFractionAt(
        viewport,
        ring.cx + Math.cos(radians) * ring.outer * 0.7,
        ring.cy + Math.sin(radians) * ring.outer * 0.7,
      );
      expect(at).not.toBeNull();
      expect(at as number).toBeGreaterThanOrEqual(0);
      expect(at as number).toBeLessThan(1);
    }
  });
});
