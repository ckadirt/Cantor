import { Skia } from '@shopify/react-native-skia';
import { drawLabelMorph, planLabelMorph, planShelfLabels } from '../labelMorph';

const NOW = new Date(2026, 7, 30, 12).getTime();
const font = Skia.Font(undefined, 9);
/**
 * Clusters as `layoutField` reports them: a key, a name, and their songs.
 * A cluster's seat is stable for its name, the way a grid slot is, so an
 * unchanged cluster does not look like one that moved.
 */
const seats = new Map<string, number>();
const group = (label: string, ...entityKeys: string[]) => {
  if (!seats.has(label)) seats.set(label, (seats.size + 1) * 100);
  return { key: label, label, entityKeys, cx: seats.get(label)!, cy: 0 };
};
const groups = (...labels: string[]) => labels.map(label => group(label, 's1'));

describe('shelf label morphs', () => {
  it('plans nothing when the label did not change', () => {
    expect(planLabelMorph('AUGUST', 'AUGUST', font)).toBeNull();
    expect(
      planShelfLabels(groups('2026-08'), groups('2026-08'), font, NOW),
    ).toBeNull();
  });

  it('fades a line that has nothing to correspond with', () => {
    const entering = planLabelMorph('', 'AUGUST', font);
    expect(entering).toMatchObject({ kind: 'enter', to: 'AUGUST' });
    const leaving = planLabelMorph('AUGUST', '', font);
    expect(leaving).toMatchObject({ kind: 'exit', from: 'AUGUST' });
    // A year has no key beneath it, so that line leaves rather than morphing.
    expect(planLabelMorph('2026-08', '', font)?.kind).toBe('exit');
  });

  it('duplicates one name into every cluster its songs went to', () => {
    // One month becomes three playlists. Every playlist's label is born from
    // the month, so three copies of AUGUST leave the same seat.
    const flights = planShelfLabels(
      [group('2026-08', 'a', 'b', 'c')],
      [group('Drive', 'a'), group('Dusk', 'b'), group('Focus', 'c')],
      font,
      NOW,
    );
    expect(flights).toHaveLength(3);
    const departures = flights!.map(flight => flight.from.x);
    expect(new Set(departures).size).toBe(1);
    // And each copy is going somewhere of its own.
    expect(new Set(flights!.map(flight => flight.to.x)).size).toBe(3);
    expect(flights!.map(flight => flight.toGroupKey)).toEqual([
      'Drive',
      'Dusk',
      'Focus',
    ]);
  });

  it('folds the names that lost their cluster into the one that took it', () => {
    // Three playlists become one month: one label becomes AUGUST and the other
    // two travel into it with nothing to become.
    const flights = planShelfLabels(
      [group('Drive', 'a'), group('Dusk', 'b'), group('Focus', 'c')],
      [group('2026-08', 'a', 'b', 'c')],
      font,
      NOW,
    );
    expect(flights).toHaveLength(3);
    const becoming = flights!.filter(flight => flight.toGroupKey !== null);
    const folding = flights!.filter(flight => flight.toGroupKey === null);
    expect(becoming).toHaveLength(1);
    expect(folding).toHaveLength(2);
    // The folding names all head for the cluster that absorbed their songs.
    for (const flight of folding) {
      expect(flight.to).toEqual(becoming[0].to);
      expect(flight.from).not.toEqual(flight.to);
    }
  });

  it('follows the songs rather than the order of the list', () => {
    // The new cluster's songs all came from the *second* old cluster, so that
    // is what its name grows out of — index pairing would have picked the first.
    const flights = planShelfLabels(
      [group('First', 'x'), group('Second', 'a', 'b')],
      [group('Only', 'a', 'b')],
      font,
      NOW,
    );
    const becoming = flights!.find(flight => flight.toGroupKey === 'Only');
    const folding = flights!.find(flight => flight.toGroupKey === null);
    expect(becoming).toBeDefined();
    expect(folding).toBeDefined();
    // `Second` was seated after `First`, so a larger seat is how we can tell
    // the name grew out of the cluster that actually held those songs.
    expect(becoming!.from.x).toBeGreaterThan(folding!.from.x);
  });

  it('never plans against an empty history, so first paint does not animate', () => {
    expect(planShelfLabels([], groups('2026-08'), font, NOW)).toBeNull();
  });

  /**
   * `Skia.Path.MakeFromText` does not exist under CanvasKit, which is what jest
   * runs. The contract is that the plan degrades to null and the caller draws
   * the settled text — never a half-built morph.
   */
  it('degrades to no plan when the runtime has no glyph outlines', () => {
    const plan = planLabelMorph('THIS WEEK', 'AUGUST', font);
    expect(plan === null || plan.kind === 'morph').toBe(true);
  });

  it('draws an entering line without throwing, at both ends of the clock', () => {
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 200, 100));
    const paint = Skia.Paint();
    const entering = planLabelMorph('', 'AUGUST', font);
    expect(entering).not.toBeNull();
    for (const t of [0, 0.5, 1]) {
      expect(() =>
        drawLabelMorph(canvas, entering!, 100, 50, t, paint, 1, font),
      ).not.toThrow();
    }
    expect(recorder.finishRecordingAsPicture()).toBeTruthy();
  });
});
