import type { SkPicture } from '@shopify/react-native-skia';
import { PAN_KNOBS, newPanHeld, panFrame } from '../panPicture';

const picture = (id: number) => ({ id }) as unknown as SkPicture;

function harness() {
  const held = newPanHeld();
  const recorded: { camera: { x: number; y: number; scale: number }; margin: number }[] = [];
  const record = (camera: { x: number; y: number; scale: number }, margin: number) => {
    recorded.push({ camera: { ...camera }, margin });
    return picture(recorded.length);
  };
  return { held, recorded, record };
}

const at = (x: number, y: number, scale = 2) => ({ x, y, scale });

describe('panFrame', () => {
  it('draws plain, recording each frame, while there is no key', () => {
    const { held, recorded, record } = harness();
    const a = panFrame(held, null, at(0, 0), record);
    const b = panFrame(held, null, at(1, 0), record);
    expect(recorded).toHaveLength(2);
    expect([a.tx, a.ty, b.tx, b.ty]).toEqual([0, 0, 0, 0]);
    expect(recorded.every(entry => entry.margin === 0)).toBe(true);
  });

  it('records once past the screen, then only shifts while the camera pans', () => {
    const { held, recorded, record } = harness();
    const key = ['cut', 2];
    const first = panFrame(held, key, at(0, 0), record);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].margin).toBe(PAN_KNOBS.MARGIN_PX);
    expect(first.tx).toBe(-PAN_KNOBS.MARGIN_PX);
    // 40 world units at scale 2 is 80 px: well inside the reach.
    const moved = panFrame(held, key, at(40, -20), record);
    expect(recorded).toHaveLength(1);
    expect(moved.picture).toBe(first.picture);
    // The picture stands where it did; the camera moved, so it moves the other way.
    expect(moved.tx).toBeCloseTo(-40 * 2 - PAN_KNOBS.MARGIN_PX);
    expect(moved.ty).toBeCloseTo(20 * 2 - PAN_KNOBS.MARGIN_PX);
  });

  it('records again when the camera has used its share of the margin', () => {
    const { held, recorded, record } = harness();
    const key = ['cut'];
    panFrame(held, key, at(0, 0), record);
    const reachWorld = (PAN_KNOBS.MARGIN_PX * PAN_KNOBS.REUSE) / 2;
    panFrame(held, key, at(reachWorld - 1, 0), record);
    expect(recorded).toHaveLength(1);
    panFrame(held, key, at(reachWorld + 5, 0), record);
    expect(recorded).toHaveLength(2);
  });

  it('records again, centred ahead of the pan, so a fling spends its margin forwards', () => {
    const { held, recorded, record } = harness();
    const key = ['cut'];
    panFrame(held, key, at(0, 0), record);
    panFrame(held, key, at(10, 0), record);
    const far = at(200, 0);
    const frame = panFrame(held, key, far, record);
    expect(recorded).toHaveLength(2);
    const ref = recorded[1].camera;
    expect(ref.x).toBeGreaterThan(far.x);
    expect(ref.y).toBeCloseTo(0);
    expect(frame.tx).toBeCloseTo((ref.x - far.x) * far.scale - PAN_KNOBS.MARGIN_PX);
    // And it is good for a while more in the direction it is going.
    panFrame(held, key, at(240, 0), record);
    expect(recorded).toHaveLength(2);
  });

  it('records again the moment anything it is drawn from changes', () => {
    const { held, recorded, record } = harness();
    panFrame(held, ['cut', 1, 'a'], at(0, 0), record);
    panFrame(held, ['cut', 1, 'a'], at(1, 0), record);
    expect(recorded).toHaveLength(1);
    panFrame(held, ['cut', 1, 'b'], at(1, 0), record);
    expect(recorded).toHaveLength(2);
    // A zoom is a change: the scale is part of every key.
    panFrame(held, ['cut', 1, 'b', 3], at(1, 0, 3), record);
    expect(recorded).toHaveLength(3);
  });

  it('forgets what it held when asked to draw plain', () => {
    const { held, recorded, record } = harness();
    panFrame(held, ['k'], at(0, 0), record);
    panFrame(held, null, at(0, 0), record);
    panFrame(held, ['k'], at(0, 0), record);
    expect(recorded).toHaveLength(3);
  });
});
