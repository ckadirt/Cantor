import { TRANSFER_PACE_KNOBS, TransferPace } from '../transferPace';

const CHUNK = 64 * 1024;

function pace() {
  let now = 0;
  const value = new TransferPace(CHUNK, () => now);
  return { value, advance: (ms: number) => (now += ms) };
}

describe('TransferPace', () => {
  it('starts small and opens by one per settled slice', () => {
    const { value } = pace();
    expect(value.window).toBe(TRANSFER_PACE_KNOBS.INITIAL_WINDOW);
    value.settled(CHUNK);
    value.settled(CHUNK);
    expect(value.window).toBe(TRANSFER_PACE_KNOBS.INITIAL_WINDOW + 2);
  });

  it('never holds more than the byte ceiling in flight', () => {
    const { value } = pace();
    for (let i = 0; i < 1000; i += 1) value.settled(CHUNK);
    expect(value.window).toBe(TRANSFER_PACE_KNOBS.MAX_IN_FLIGHT_BYTES / CHUNK);
  });

  it('holds only what a slow link delivers within the budget', () => {
    const { value, advance } = pace();
    // 16 KiB/s: well under one slice per timeout-safe budget.
    for (let i = 0; i < 4; i += 1) {
      advance(4_000);
      value.settled(CHUNK);
    }
    expect(value.window).toBe(TRANSFER_PACE_KNOBS.MIN_WINDOW);
  });

  it('reopens when the link recovers', () => {
    const { value, advance } = pace();
    advance(0);
    value.settled(CHUNK);
    advance(4_000);
    value.settled(CHUNK);
    expect(value.window).toBe(TRANSFER_PACE_KNOBS.MIN_WINDOW);
    for (let i = 0; i < 100; i += 1) {
      advance(10);
      value.settled(CHUNK);
    }
    expect(value.window).toBeGreaterThan(50);
  });
});
