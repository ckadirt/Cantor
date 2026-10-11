import { load, trackOf } from '../../../lenses/motion/__fixtures__/referenceTrack';
import { clockCutsOf, formLetterInks, formLetterRadius, formLetterSeats, NO_CUTS } from '../NativePlayer';

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

  it('stands inside the circle’s arc and outside the seal’s rim, and between them in a change', () => {
    const ring = 60;
    // The circle's letters stand in the well, beside their cuts.
    expect(formLetterRadius(ring, 0, 6)).toBeLessThan(ring - 9);
    // The seal's stand clear of the rim.
    expect(formLetterRadius(ring, 1, 6)).toBeGreaterThan(ring + 9);
    const half = formLetterRadius(ring, 0.5, 6);
    expect(half).toBeGreaterThan(formLetterRadius(ring, 0, 6));
    expect(half).toBeLessThan(formLetterRadius(ring, 1, 6));
  });

  it('seats each letter on its ring, centred on its section', () => {
    const r = 150;
    const seats = formLetterSeats(cuts, r, 6, 7);
    expect(seats.length / 4).toBe(track.sections.length);
    for (let i = 0; i < seats.length; i += 4) {
      const cx = seats[i] + 3;
      const cy = seats[i + 1] - 3.5;
      expect(Math.hypot(cx, cy)).toBeCloseTo(r, 6);
      // Clockwise from twelve, like the clock.
      const turn = (Math.atan2(cx, -cy) / (2 * Math.PI) + 1) % 1;
      expect(turn).toBeCloseTo(cuts.middles[i / 4], 6);
    }
  });

  it('steps a crowded letter onto a second ring, rather than leaving it out', () => {
    const crowded = { ...NO_CUTS, middles: [0.1, 0.101, 0.102], labels: [0, 1, 2] };
    const seats = formLetterSeats(crowded, 151, 6, 7, null, -11);
    // A on the first ring, B on the second, C crowds both and gives way.
    expect(seats.filter((_, i) => i % 4 === 2)).toEqual([0, 1]);
    expect(Math.hypot(seats[4] + 3, seats[5] - 3.5)).toBeCloseTo(140, 6);
  });

  it('leaves out a letter that would crowd the one before it, and one past Z', () => {
    const crowded = {
      ...NO_CUTS,
      middles: [0.002, 0.003, 0.3, 0.999, 0.5],
      labels: [0, 1, 2, 3, 26],
    };
    const seats = formLetterSeats(crowded, 151, 6, 7);
    // 0.003 crowds 0.002; 0.999 crowds 0.002 across twelve; Z+1 has no letter.
    expect(seats.filter((_, i) => i % 4 === 2)).toEqual([0, 2]);
  });

  describe('which letters are written', () => {
    // Red Lights: A B A C D E F G C D E H E.
    const at = (i: number, into = 0.5) => cuts.starts[i] + (cuts.starts[i + 1] - cuts.starts[i]) * into;
    const written = (inks: number[]) => inks.map((ink, i) => (ink > 0.01 ? i : -1)).filter(i => i >= 0);

    it('writes the whole form: the section you are in firmest, its repeats next, the rest quiet', () => {
      const c = cuts.labels.indexOf(3); // the first C
      const inks = formLetterInks(cuts, at(c));
      expect(written(inks)).toEqual(cuts.labels.map((_, i) => i));
      const runs = cuts.labels.map((label, i) => (label === cuts.labels[c] ? i : -1)).filter(i => i >= 0);
      const others = cuts.labels.map((_, i) => i).filter(i => !runs.includes(i));
      for (const i of runs) if (i !== c) expect(inks[c]).toBeGreaterThan(inks[i]);
      for (const i of others) expect(inks[runs.find(j => j !== c)!]).toBeGreaterThan(inks[i]);
    });

    it('crosses over the first bar of a section, from the last one’s letters', () => {
      const i = 3;
      const enter = cuts.starts[i];
      const leaving = formLetterInks(cuts, enter);
      const half = formLetterInks(cuts, enter + cuts.bar / 2);
      const settled = formLetterInks(cuts, enter + cuts.bar * 1.01);
      // On the cut, the last section is still the firm one; after a bar, this one is.
      expect(settled[i - 1]).toBeLessThan(leaving[i - 1]);
      expect(settled[i]).toBeGreaterThan(leaving[i]);
      expect(half[i]).toBeGreaterThan(leaving[i]);
      expect(half[i]).toBeLessThan(settled[i]);
    });

    it('names the first section from the start, before anything has played', () => {
      expect(written(formLetterInks(cuts, 0))).toContain(0);
      expect(formLetterInks(NO_CUTS, 0)).toEqual([]);
    });
  });
});
