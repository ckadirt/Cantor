import { motionFrameAt, type MotionFrame } from '../../lenses/motion/motionFrame';
import type { MotionTrack } from '../../lenses/motion/motionTrack';
import { PLAYER_VERB_POSE } from './NativePlayer';

/**
 * The music at this moment, for the player — or null, which wakes nothing,
 * whenever there is no motion to draw: no track yet, nothing risen yet
 * (`presence`, the scene's `motionIn`), or reduced motion, under which the
 * player is today's still one.
 *
 * What sounds (`transient`) settles with the transport's own play/pause morph
 * (`verb`, `PLAYER_VERB_POSE`, null with no transport), so a pause — or a
 * scrub, which pauses the port — does not freeze a kick mid-swell, and the
 * form stays where the song is (reactive-player-plan.md, "Paused",
 * "Scrubbing", "Reduced motion").
 */
export function playerMotionFrame(
  track: MotionTrack | null,
  t: number | null,
  presence: number,
  reducedMotion: boolean,
  verb: number | null,
): MotionFrame | null {
  'worklet';
  if (track === null || presence <= 0 || reducedMotion || t === null) return null;
  const transient =
    verb === null ? 1 : Math.min(Math.max(verb - PLAYER_VERB_POSE.play, 0), 1);
  const frame = motionFrameAt(track, t, transient);
  frame.presence = presence;
  return frame;
}
