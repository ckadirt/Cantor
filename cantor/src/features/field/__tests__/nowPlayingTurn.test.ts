import { load, trackOf } from '../../../lenses/motion/__fixtures__/referenceTrack';
import { steppedBeatsAt } from '../../../lenses/motion/motionFrame';
import { CIRCLE_MOTION_KNOBS } from '../../../lenses/circleMotion';
import { NOW_PLAYING_KNOBS, markTurnAdvance } from '../NowPlaying';

const SHARE = CIRCLE_MOTION_KNOBS.STEP_SHARE;

describe('the now-playing mark, in time with its song', () => {
  const track = trackOf(load('edm-drop'));

  it('counts beats that step over the first share of each and then stand', () => {
    const [b0, b1] = [track.beats[100], track.beats[101]];
    expect(steppedBeatsAt(track, b0, SHARE)).toBeCloseTo(100, 9);
    expect(steppedBeatsAt(track, b0 + (b1 - b0) * SHARE, SHARE)).toBeCloseTo(101, 9);
    expect(steppedBeatsAt(track, b0 + (b1 - b0) * 0.9, SHARE)).toBeCloseTo(101, 9);
    expect(steppedBeatsAt(track, track.beats[0] - 1, SHARE)).toBe(0);
  });

  it('turns a beat’s share a beat when sure, through a song played frame by frame', () => {
    let turn = 0;
    let were = -1;
    const from = track.beats[200];
    for (let t = from; t <= from + 10; t += 1 / 60) {
      const now = steppedBeatsAt(track, t, SHARE);
      turn += markTurnAdvance(were, now, 1, 1 / 60, 1);
      were = now;
    }
    const counted = steppedBeatsAt(track, from + 10, SHARE) - steppedBeatsAt(track, from, SHARE);
    expect(turn).toBeCloseTo(counted * NOW_PLAYING_KNOBS.BEAT_TURN, 6);
  });

  it('turns evenly with no grid, and not at all paused', () => {
    expect(markTurnAdvance(-1, -1, 0, 1, 1)).toBeCloseTo(1 / NOW_PLAYING_KNOBS.TURN_S, 9);
    expect(markTurnAdvance(-1, -1, 0, 1, 0)).toBe(0);
    // A grid it is half sure of: half of each.
    expect(markTurnAdvance(10, 10.5, 0.5, 1, 1)).toBeCloseTo(
      0.5 / NOW_PLAYING_KNOBS.TURN_S + 0.25 * NOW_PLAYING_KNOBS.BEAT_TURN,
      9,
    );
  });

  it('lets a seek go rather than spinning to catch it', () => {
    expect(markTurnAdvance(10, 9, 1, 1 / 60, 1)).toBe(0);
    expect(markTurnAdvance(10, 40, 1, 1 / 60, 1)).toBe(0);
    expect(markTurnAdvance(-1, 40, 1, 1 / 60, 1)).toBe(0);
  });
});
