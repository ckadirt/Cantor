import { load, trackOf } from '../../../lenses/motion/__fixtures__/referenceTrack';
import { PLAYER_VERB_POSE } from '../NativePlayer';
import { playerMotionFrame } from '../playerMotion';

/**
 * The edges of the player's motion (reactive-player-plan.md, "Things that
 * must match"): reduced motion, a pause, a scrub, a song not yet measured.
 */
describe('the player’s motion at its edges', () => {
  const track = trackOf(load('edm-drop'));
  const drop = track.drops[1];
  // On a kick, building into a drop: both what sounds and the form are up.
  const t = drop.t - 0.3;
  const kick = track.onsets[0].t.find(at => at > t - 0.2 && at < t)!;
  const at = kick + 0.01;

  it('is nothing at all under reduced motion: the player is today’s', () => {
    expect(playerMotionFrame(track, at, 1, true, PLAYER_VERB_POSE.pause)).toBeNull();
  });

  it('is nothing before the track exists, or before it has risen, or with no clock', () => {
    expect(playerMotionFrame(null, at, 1, false, PLAYER_VERB_POSE.pause)).toBeNull();
    expect(playerMotionFrame(track, at, 0, false, PLAYER_VERB_POSE.pause)).toBeNull();
    expect(playerMotionFrame(track, null, 1, false, PLAYER_VERB_POSE.pause)).toBeNull();
  });

  it('carries how far it has risen', () => {
    expect(playerMotionFrame(track, at, 0.4, false, PLAYER_VERB_POSE.pause)!.presence).toBe(0.4);
  });

  it('lets what sounds settle on a pause (a scrub pauses too) and keeps where the song is', () => {
    // The transport's verb shows *pause* while it plays, *play* while paused.
    const playing = playerMotionFrame(track, at, 1, false, PLAYER_VERB_POSE.pause)!;
    const paused = playerMotionFrame(track, at, 1, false, PLAYER_VERB_POSE.play)!;
    const halfway = playerMotionFrame(track, at, 1, false, (PLAYER_VERB_POSE.play + PLAYER_VERB_POSE.pause) / 2)!;
    expect(playing.low).toBeGreaterThan(0);
    expect([paused.low, paused.mid, paused.high, paused.beat, paused.down]).toEqual([0, 0, 0, 0, 0]);
    expect(paused.ripples).toEqual([]);
    expect(halfway.low).toBeCloseTo(playing.low / 2, 9);
    // The form is where the song is, paused or not.
    expect([paused.section, paused.label, paused.tension]).toEqual([playing.section, playing.label, playing.tension]);
    expect(paused.tension).toBeGreaterThan(0);
  });

  it('plays in full with no transport to ask', () => {
    expect(playerMotionFrame(track, at, 1, false, null)!.low).toBe(
      playerMotionFrame(track, at, 1, false, PLAYER_VERB_POSE.pause)!.low,
    );
  });
});
