import { Skia } from '@shopify/react-native-skia';
import { byDate, byPlaylist } from '../../../field/arrangements';
import { layoutField, type FieldEntity } from '../../../field';
import {
  drawLabelMorph,
  labelFlightAlpha,
  planLabelMorph,
  planShelfLabels,
  settledShelfLabelFlights,
} from '../labelMorph';

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
  return {
    key: label,
    label,
    entityKeys,
    cx: seats.get(label)!,
    cy: 0,
    top: 0,
    topGathered: 0,
  };
};
const groups = (...labels: string[]) => labels.map(label => group(label, 's1'));

describe('shelf label morphs', () => {
  /**
   * A settled field is the ordinary state, and it still has names in it.
   *
   * `planShelfLabels` answers null there, and the native renderer draws only
   * flights — so without a standing-still flight it had nothing to draw and
   * the canvas fell back to the recorded picture for want of a label, which is
   * how L0 and L1 ended up on the picture path in the first place.
   */
  it('carries a settled field\'s names as flights that go nowhere', () => {
    const flights = settledShelfLabelFlights(groups('2026-08', '2026-09'), NOW);
    expect(flights).toHaveLength(2);
    for (const flight of flights ?? []) {
      expect(flight.from).toEqual(flight.to);
      expect(flight.fromTop).toBe(flight.toTop);
      expect(flight.primaryFrom).toBe(flight.primaryTo);
      expect(flight.primary).toBeNull();
      expect(flight.ownership).toBe('carry');
      expect(flight.fromAlpha).toBe(1);
      expect(flight.targetAlpha).toBe(1);
    }
    // The same reading the picture's settled path draws, uppercased.
    expect(flights?.[0].primaryTo).toBe(flights?.[0].primaryTo.toUpperCase());
    expect(settledShelfLabelFlights([], NOW)).toBeNull();
  });

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
    expect(flights!.map(flight => flight.ownership)).toEqual([
      'carry',
      'branch',
      'branch',
    ]);
    expect(flights!.map(flight => labelFlightAlpha(flight, 0))).toEqual([
      1,
      0,
      0,
    ]);
    expect(flights!.map(flight => labelFlightAlpha(flight, 0.18))).toEqual([
      1,
      1,
      1,
    ]);
    expect(
      flights!.every(
        flight =>
          flight.primary?.kind === 'crossfade' &&
          flight.primary.pairs.length === 0,
      ),
    ).toBe(true);
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
    // Folding is carried by the morph's kind, not by the seat: every flight
    // lands on a real cluster so it can aim at the seat a label would use.
    const folding = flights!.filter(
      flight => flight.primary?.kind === 'exit',
    );
    expect(folding).toHaveLength(2);
    expect(folding.every(flight => flight.ownership === 'fold')).toBe(true);
    expect(folding.every(flight => labelFlightAlpha(flight, 0.82) === 0)).toBe(
      true,
    );
    for (const flight of flights!) {
      expect(flight.toGroupKey).toBe('2026-08');
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
    const becoming = flights!.find(flight => flight.primary?.kind !== 'exit');
    const folding = flights!.find(flight => flight.primary?.kind === 'exit');
    expect(becoming).toBeDefined();
    expect(folding).toBeDefined();
    // `Second` was seated after `First`, so a larger seat is how we can tell
    // the name grew out of the cluster that actually held those songs.
    expect(becoming!.from.x).toBeGreaterThan(folding!.from.x);
  });

  /**
   * The case that exposed the bug. One month becomes one year: same songs,
   * same cluster, same seat. The label has to morph where it stands, and it
   * only can if both ends of the flight are the same point — the drawing side
   * turns that into a zero offset from the settled seat.
   */
  it('leaves a cluster that did not move exactly where it is', () => {
    const august = group('2026-08', 'a', 'b');
    const year = { ...group('2026', 'a', 'b'), cx: august.cx, cy: august.cy };
    const flights = planShelfLabels([august], [year], font, NOW);
    expect(flights).toHaveLength(1);
    expect(flights![0].from).toEqual(flights![0].to);
    expect(flights![0].toGroupKey).toBe('2026');
  });

  /**
   * The seat, not the centre. A name hangs from the top of its cluster, so a
   * flight has to be expressed in tops at both ends: a cluster that changes
   * size keeps its centre and moves its top, and a flight that lerps an offset
   * between centres into a destination seat steps by that difference on its
   * very first frame. Switching dates for playlists re-cuts every cluster, so
   * every name stepped.
   */
  it('leaves and lands on cluster tops, so the first frame does not step', () => {
    const viewport = { width: 380, height: 800 };
    const entities: FieldEntity[] = [
      'a',
      'b',
      'c',
      'd',
      'e',
    ].map((id, index) => ({
      key: `node-a:${id}`,
      nodePublicKey: 'node-a',
      entityId: id,
      kind: 'song' as const,
      createdAtMs: Date.UTC(2026, index < 2 ? 6 : 7, 8),
      durationMs: 0,
      tags: index % 2 === 0 ? ['p/Drive'] : ['p/Dusk'],
    }));
    const dates = layoutField({
      entities,
      arrangement: byDate('month'),
      viewport,
    });
    const playlists = layoutField({
      entities,
      arrangement: byPlaylist,
      viewport,
    });
    // Clusters of different sizes, which is what makes centre and top differ.
    expect(new Set(dates.groups.map(cluster => cluster.top)).size).toBe(
      dates.groups.length,
    );
    for (const cluster of [...dates.groups, ...playlists.groups]) {
      expect(cluster.top).toBeLessThan(cluster.cy);
    }

    const flights = planShelfLabels(dates.groups, playlists.groups, font, NOW);
    expect(flights).not.toBeNull();
    for (const flight of flights!) {
      const leaves = dates.groups.find(
        cluster => cluster.key === flight.fromGroupKey,
      );
      const lands = playlists.groups.find(
        cluster => cluster.key === flight.toGroupKey,
      );
      // Where the settled label was drawn a frame ago, and where a settled
      // label will be drawn when this lands.
      if (leaves !== undefined) expect(flight.fromTop).toBe(leaves.top);
      if (lands !== undefined) expect(flight.toTop).toBe(lands.top);
    }
  });

  it('does not move the seat of a cluster that kept its songs', () => {
    const august = group('2026-08', 'a', 'b');
    const year = { ...group('2026', 'a', 'b'), cx: august.cx, cy: august.cy };
    const flights = planShelfLabels([august], [year], font, NOW);
    expect(flights![0].fromTop).toBe(flights![0].toTop);
  });

  it('sends a folding label to the seat of the cluster that absorbed it', () => {
    // Not to that cluster's centre — to the cluster itself, so the drawing
    // side can aim at the same seat a settled label would use.
    const flights = planShelfLabels(
      [group('Drive', 'a'), group('Dusk', 'b')],
      [group('2026-08', 'a', 'b')],
      font,
      NOW,
    );
    const folding = flights!.filter(
      flight => flight.primary?.kind === 'exit' || flight.secondary?.kind === 'exit',
    );
    expect(folding.length).toBeGreaterThan(0);
    for (const flight of folding) expect(flight.toGroupKey).toBe('2026-08');
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
