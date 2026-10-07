import { FLIGHT_NAME, GATHER_KNOBS, type FlightTiming } from '../../../field';
import { gatherNameAt, nameHome } from '../gatherInk';

const leaving: FlightTiming = {
  start: 0.1,
  end: 0.6,
  bowPx: GATHER_KNOBS.BOW_HOME_PX,
  name: FLIGHT_NAME.ERASE,
  nameStart: 0.1,
  nameEnd: 0.2,
  fromFound: true,
  nameFrom: 1,
  inkFrom: 1,
  sideFrom: 1,
};

describe('a name leaving the found shelf', () => {
  it('erases where it stood, then writes back on at home as its face lands', () => {
    expect(gatherNameAt(leaving, 0.1)).toBe(1);
    expect(nameHome(leaving, 0.15)).toBe(false);
    expect(gatherNameAt(leaving, 0.2)).toBe(0);
    expect(nameHome(leaving, 0.2)).toBe(true);
    const writeFrom = 0.1 + 0.5 * GATHER_KNOBS.NAME_WRITE_FROM;
    expect(gatherNameAt(leaving, writeFrom - 0.01)).toBe(0);
    expect(gatherNameAt(leaving, (writeFrom + 0.6) / 2)).toBeGreaterThan(0);
    // The leave's scene stays on screen after it lands: the row has its name.
    expect(gatherNameAt(leaving, 1)).toBe(1);
  });

  it('erases only what had been written', () => {
    const unwritten = { ...leaving, nameFrom: 0 };
    expect(gatherNameAt(unwritten, 0.1)).toBe(0);
    expect(gatherNameAt(unwritten, 1)).toBe(1);
  });
});
