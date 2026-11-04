import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  byAlbum,
  byArtist,
  byPlaylist,
  byTime,
} from '../../../field';
import {
  DEFAULT_GROUPING,
  loadGrouping,
  saveGrouping,
} from '../groupingChoice';

const KEY = 'cantor.field-grouping.v1';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('the remembered grouping', () => {
  it('is date by week until someone changes it', async () => {
    expect(await loadGrouping()).toEqual(DEFAULT_GROUPING);
    expect(DEFAULT_GROUPING).toEqual({ axis: byTime.key, resolution: 'week' });
  });

  it.each([
    [byArtist.key, 'week'],
    [byAlbum.key, 'month'],
    [byPlaylist.key, 'year'],
    [byTime.key, 'year'],
    [byTime.key, 'month'],
  ] as const)('remembers %s at %s', async (axis, resolution) => {
    await saveGrouping({ axis, resolution });
    expect(await loadGrouping()).toEqual({ axis, resolution });
  });

  it('keeps the date resolution beside another axis, for when date comes back', async () => {
    await saveGrouping({ axis: byArtist.key, resolution: 'year' });
    expect(await loadGrouping()).toEqual({ axis: byArtist.key, resolution: 'year' });
  });

  it.each([
    ['not json', 'artist'],
    ['an axis this build does not have', JSON.stringify({ axis: 'mood', resolution: 'week' })],
    ['a resolution it does not have', JSON.stringify({ axis: 'time', resolution: 'decade' })],
    ['missing fields', JSON.stringify({ axis: 'time' })],
    ['the wrong shape', JSON.stringify(['time', 'week'])],
    ['null', 'null'],
  ])('opens on the default for %s', async (_, raw) => {
    await AsyncStorage.setItem(KEY, raw);
    expect(await loadGrouping()).toEqual(DEFAULT_GROUPING);
  });

  it('opens on the default when storage cannot be read', async () => {
    const read = jest
      .spyOn(AsyncStorage, 'getItem')
      .mockRejectedValueOnce(new Error('disk'));
    expect(await loadGrouping()).toEqual(DEFAULT_GROUPING);
    read.mockRestore();
  });
});
