import { GLIDE_KNOBS, glideEase, glideSpeedPxS, planGlide } from '../glide';

const camera = { x: 0, y: 0, scale: 0.5 };
const open = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 };
const seconds = GLIDE_KNOBS.GLIDE_MS / 1000;

it('rests where the finger left it below the throwing speed', () => {
  expect(
    planGlide(camera, { x: 0, y: GLIDE_KNOBS.MIN_SPEED_PX_S - 1 }, open),
  ).toBeNull();
});

it('leaves at the speed of the finger, against its direction, and arrives at rest', () => {
  const glide = planGlide(camera, { x: 0, y: -2000 }, open)!;
  expect(glide.durationMs).toBe(GLIDE_KNOBS.GLIDE_MS);
  // Dragging up moves the camera down the map.
  expect(glide.target.y).toBeCloseTo((2000 * seconds) / 3 / camera.scale, 9);
  expect(glide.target.x).toBe(0);
  expect(glide.target.scale).toBe(camera.scale);
  expect(
    glideSpeedPxS(camera, glide.target, glide.durationMs, 0),
  ).toBeCloseTo(2000, 6);
  expect(glideSpeedPxS(camera, glide.target, glide.durationMs, 1)).toBe(0);
  expect(glideEase(0)).toBe(0);
  expect(glideEase(1)).toBe(1);
});

it('takes a throw faster than the cap as the cap', () => {
  const capped = planGlide(camera, { x: 0, y: -1e6 }, open)!;
  const atCap = planGlide(
    camera,
    { x: 0, y: -GLIDE_KNOBS.MAX_SPEED_PX_S },
    open,
  )!;
  expect(capped.target.y).toBeCloseTo(atCap.target.y, 9);
});

it('stops at an edge on the same curve, sooner, still leaving at the finger speed', () => {
  const range = { minX: 0, maxX: 0, minY: 0, maxY: 400 };
  const glide = planGlide(camera, { x: 0, y: -3000 }, range)!;
  expect(glide.target.y).toBeCloseTo(400, 9);
  expect(glide.durationMs).toBeLessThan(GLIDE_KNOBS.GLIDE_MS);
  expect(
    glideSpeedPxS(camera, glide.target, glide.durationMs, 0),
  ).toBeCloseTo(3000, 6);
});

it('is not cut short by a little sideways speed against a locked axis', () => {
  const range = { minX: 0, maxX: 0, minY: -1e6, maxY: 1e6 };
  const glide = planGlide(camera, { x: -400, y: -2000 }, range)!;
  expect(glide.durationMs).toBe(GLIDE_KNOBS.GLIDE_MS);
  expect(glide.target.x).toBe(0);
  expect(glide.target.y).toBeCloseTo((2000 * seconds) / 3 / camera.scale, 9);
});

it('never carries a camera further past an edge, but carries it back', () => {
  const range = { minX: 0, maxX: 0, minY: 0, maxY: 100 };
  const past = { ...camera, y: 300 };
  expect(planGlide(past, { x: 0, y: -2000 }, range)).toBeNull();
  const back = planGlide(past, { x: 0, y: 2000 }, range)!;
  expect(back.target.y).toBeLessThan(past.y);
  expect(back.target.y).toBeGreaterThanOrEqual(0);
});

it('does not start a glide at the edge it was thrown toward', () => {
  const range = { minX: 0, maxX: 0, minY: 0, maxY: 100 };
  expect(
    planGlide({ ...camera, y: 100 }, { x: 0, y: -2000 }, range),
  ).toBeNull();
});
