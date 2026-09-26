/**
 * The angle a finger makes about the player's centre, as a turn from twelve
 * o'clock clockwise, 0..1 — or null in the dead centre, where one pixel of
 * travel sweeps half the song and an angle is noise wearing the shape of an
 * intention, and past the outer reach, which is blank space.
 *
 * One helper for every ring a lens seeks on, and for `songPose`'s screen-space
 * wrappers, so the angle is measured one way everywhere.
 */
export function ringTurnAt(
  dx: number,
  dy: number,
  inner: number,
  outer: number,
): number | null {
  'worklet';
  const reach = Math.sqrt(dx * dx + dy * dy);
  if (reach < inner || reach > outer) return null;
  const turn = (Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2);
  return turn - Math.floor(turn);
}
