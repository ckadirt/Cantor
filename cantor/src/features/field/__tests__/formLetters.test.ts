import { load, trackOf } from '../../../lenses/motion/__fixtures__/referenceTrack';
import { clockCutsOf, formLetterRadius, formLetterSeats, NO_CUTS } from '../NativePlayer';

describe('the form, lettered round the clock', () => {
  const track = trackOf(load('edm-drop'));
  const cuts = clockCutsOf(track);

  it('letters every section at its middle, and cuts all but the first', () => {
    expect(cuts.labels).toEqual(track.sections.map(s => s.label));
    expect(cuts.middles).toHaveLength(track.sections.length);
    expect(cuts.sections).toHaveLength(track.sections.length - 1);
    const first = track.sections[0];
    expect(cuts.middles[0]).toBeCloseTo((first.t0 + first.t1) / 2 / track.duration, 9);
  });

  it('writes nothing for a song of one section, or with no track', () => {
    const one = clockCutsOf({ ...track, sections: track.sections.slice(0, 1) });
    expect([one.middles, one.labels]).toEqual([[], []]);
    expect(clockCutsOf(null)).toBe(NO_CUTS);
  });

  it('stands past the circle’s tallest tick, and past the seal’s rim', () => {
    const radius = 144;
    // The circle's clock is its arc, at half the radius; its ticks reach 0.86.
    expect(formLetterRadius(radius, radius * 0.5, 6)).toBeGreaterThan(radius * 0.86 + 3);
    // The seal's clock is its rim, further out than the ticks.
    expect(formLetterRadius(radius, radius * 0.93, 6)).toBeGreaterThan(radius * 0.93 + 3);
  });

  it('seats each letter on its ring, centred on its section', () => {
    const r = 150;
    const seats = formLetterSeats(cuts, r, 6, 7);
    expect(seats.length / 3).toBe(track.sections.length);
    for (let i = 0; i < seats.length; i += 3) {
      const cx = seats[i] + 3;
      const cy = seats[i + 1] - 3.5;
      expect(Math.hypot(cx, cy)).toBeCloseTo(r, 6);
      // Clockwise from twelve, like the clock.
      const turn = (Math.atan2(cx, -cy) / (2 * Math.PI) + 1) % 1;
      expect(turn).toBeCloseTo(cuts.middles[i / 3], 6);
    }
  });

  it('leaves out a letter that would crowd the one before it, and one past Z', () => {
    const crowded = {
      ...NO_CUTS,
      middles: [0.002, 0.003, 0.3, 0.999, 0.5],
      labels: [0, 1, 2, 3, 26],
    };
    const seats = formLetterSeats(crowded, 151, 6, 7);
    // 0.003 crowds 0.002; 0.999 crowds 0.002 across twelve; Z+1 has no letter.
    expect(seats.filter((_, i) => i % 3 === 2)).toEqual([0, 2]);
  });
});
