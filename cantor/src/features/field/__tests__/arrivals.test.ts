/**
 * Ink that changes under a song already on screen arrives on its own clock.
 *
 * The startup pop was the case that named it: a downloaded song is drawn as an
 * outline until the phone has found its file, then snapped to filled. These
 * pin the rules that keep the change continuous — what starts a clock, what
 * leaves a running one alone, and where an interrupted one starts from.
 */
import { arriveInk, inkAt, type InkArrival } from '../arrivals';
import type { FieldPresentation } from '../useFieldController';

function song(
  key: string,
  state: FieldPresentation['localAudio']['state'],
  bytes = 0,
): [string, FieldPresentation] {
  return [
    key,
    { localAudio: { state, bytes } } as unknown as FieldPresentation,
  ];
}

function field(
  ...songs: [string, FieldPresentation][]
): ReadonlyMap<string, FieldPresentation> {
  return new Map(songs);
}

/** The clock stood at `value`, as the UI thread last left it. */
function at(arrival: InkArrival, value: number): InkArrival {
  arrival.clock!.value = value;
  return arrival;
}

describe('arriveInk', () => {
  it('draws the first field it sees as it is, with no clock', () => {
    const first = arriveInk(null, field(song('a', 'pinned')));
    expect(first.clock).toBeNull();
    expect(first.from.size).toBe(0);
    expect(first.to.get('a')).toEqual({ stroke: 1, fill: 1, title: 1 });
  });

  it('gives a song found on the phone a clock from its outline', () => {
    const launch = arriveInk(null, field(song('a', 'remote'), song('b', 'remote')));
    const found = arriveInk(launch, field(song('a', 'pinned'), song('b', 'remote')));
    expect(found.clock?.value).toBe(0);
    // Only the song that changed moves; the other is drawn where it stands.
    expect([...found.from.keys()]).toEqual(['a']);
    expect(inkAt(found, 'a', 0)).toEqual(launch.to.get('a'));
    expect(inkAt(found, 'a', 1)).toEqual({ stroke: 1, fill: 1, title: 1 });
    expect(inkAt(found, 'b', 0)).toBe(launch.to.get('b'));
  });

  it('keeps itself when the ink did not change, so a download tick restarts nothing', () => {
    const launch = arriveInk(null, field(song('a', 'remote')));
    // Arriving is drawn as not being here: no clock for starting a download.
    expect(arriveInk(launch, field(song('a', 'partial', 10)))).toBe(launch);
    const started = at(arriveInk(launch, field(song('a', 'cached', 10))), 0.4);
    expect(arriveInk(started, field(song('a', 'cached', 20)))).toBe(started);
    expect(started.clock?.value).toBe(0.4);
  });

  it('starts an interrupting arrival from what was drawn, not from either end', () => {
    const launch = arriveInk(null, field(song('a', 'remote')));
    const cached = at(arriveInk(launch, field(song('a', 'cached'))), 0.5);
    const drawn = inkAt(cached, 'a', 0.5)!;
    const pinned = arriveInk(cached, field(song('a', 'pinned')));
    expect(pinned.clock?.value).toBe(0);
    expect(inkAt(pinned, 'a', 0)).toEqual(drawn);
    expect(drawn.stroke).toBeGreaterThan(launch.to.get('a')!.stroke);
    expect(drawn.stroke).toBeLessThan(cached.to.get('a')!.stroke);
  });

  it('brings a new song in at its ink: the re-cut is its arrival', () => {
    const launch = arriveInk(null, field(song('a', 'remote')));
    const grown = arriveInk(launch, field(song('a', 'remote'), song('b', 'pinned')));
    expect(grown).not.toBe(launch);
    expect(grown.clock).toBeNull();
    expect(inkAt(grown, 'b', 0)).toEqual({ stroke: 1, fill: 1, title: 1 });
  });
});
