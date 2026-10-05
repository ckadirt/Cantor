import { emptyFilterSentence, filterPhrase } from '../filterWords';

const words = (text: string, segments: { start: number; end: number }[]) =>
  segments.map(segment => text.slice(segment.start, segment.end));

describe("the filter's words", () => {
  it('names one tag, or two joined by the mode', () => {
    expect(filterPhrase({ tags: ['rainy'], mode: 'any' }).text).toBe('RAINY');
    const any = filterPhrase({ tags: ['rainy', 'Live'], mode: 'any' });
    expect(any.text).toBe('RAINY OR LIVE');
    expect(any.segments.map(segment => segment.kind)).toEqual([
      'tag',
      'join',
      'tag',
    ]);
    expect(words(any.text, [...any.segments])).toEqual(['RAINY', 'OR', 'LIVE']);
    expect(filterPhrase({ tags: ['rainy', 'live'], mode: 'all' }).text).toBe(
      'RAINY AND LIVE',
    );
  });

  it('says how many more past two, as one target', () => {
    const phrase = filterPhrase({
      tags: ['rainy', 'live', 'warm'],
      mode: 'any',
    });
    expect(phrase.text).toBe('RAINY OR 2 MORE');
    expect(words(phrase.text, [...phrase.segments])).toEqual([
      'RAINY',
      'OR',
      '2 MORE',
    ]);
    expect(phrase.segments[2].kind).toBe('more');
  });

  it('says nothing with no filter', () => {
    expect(filterPhrase({ tags: [], mode: 'any' })).toEqual({
      text: '',
      segments: [],
    });
  });

  it('says what an empty map is missing, as the tags were chosen', () => {
    expect(emptyFilterSentence({ tags: ['rainy'], mode: 'all' })).toBe(
      'No songs are rainy.',
    );
    expect(
      emptyFilterSentence({ tags: ['rainy', 'live', 'warm'], mode: 'all' }),
    ).toBe('No songs are rainy, live and warm.');
    expect(emptyFilterSentence({ tags: ['a', 'b'], mode: 'any' })).toBe(
      'No songs are a or b.',
    );
  });
});

describe('a phrase too long for its row', () => {
  const filter = { tags: ['ultrafav', 'second tag'], mode: 'any' } as const;

  it('names fewer, then shortens the name, then only counts', () => {
    expect(filterPhrase(filter, text => text.length <= 18).text).toBe(
      'ULTRAFAV OR 1 MORE',
    );
    const cut = filterPhrase(
      { ...filter, mode: 'all' },
      text => text.length <= 16,
    );
    expect(cut.text).toBe('ULTR… AND 1 MORE');
    expect(cut.segments.map(segment => segment.kind)).toEqual([
      'tag',
      'join',
      'more',
    ]);
    const counted = filterPhrase(filter, text => text.length <= 10);
    expect(counted.text).toBe('2 TAGS');
    expect(counted.segments).toEqual([{ start: 0, end: 6, kind: 'more' }]);
  });
});
