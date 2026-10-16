import { BUILT_IN_ACTS, actOn, actsOf, inputOf, parseActs } from '../acts';
import type { ModelView } from '../types';
import { wordsForAct } from '../../audioActs';

const remix = {
  id: 'remix',
  label: 'A remix',
  needs: 'cover',
  sources: ['song'],
  inputs: [
    { kind: 'follow', stops: [0, 1] },
    { kind: 'prompt', required: false, default: 'A remix of it' },
  ],
};

describe('acts on the wire', () => {
  it('reads what the node declares', () => {
    expect(parseActs([remix])).toEqual([remix]);
    expect(parseActs(undefined)).toBeUndefined();
  });

  it('drops an act it could not fill, and keeps the rest', () => {
    const parsed = parseActs([
      remix,
      // An input kind from a newer catalog.
      { ...remix, id: 'redo', inputs: [{ kind: 'region' }] },
      // A capability the request cannot name.
      { ...remix, id: 'stems', needs: 'separate' },
      // Not a wire name.
      { ...remix, id: 'A Remix' },
      // Follow stops outside 0..1.
      { ...remix, id: 'wild', inputs: [{ kind: 'follow', stops: [2] }] },
      // An id once.
      { ...remix, label: 'again' },
    ]);
    expect(parsed?.map(act => act.id)).toEqual(['remix']);
  });
});

describe('the acts a model offers', () => {
  const older = (kinds: string[]): ModelView => ({
    selector: 'acestep:1.5-fast',
    family: 'acestep',
    engine: 'acestep',
    capabilities: kinds.map(kind => ({ kind })) as ModelView['capabilities'],
  });

  it('reads an older node through the built-in acts it can run', () => {
    expect(actsOf(older(['cover', 'timbre'])).map(act => act.id)).toEqual([
      'version',
      'hum',
    ]);
    expect(
      inputOf(actOn(older(['cover', 'timbre']), 'version'), 'voice'),
    ).toBeDefined();
    // No `timbre`: no Voice.
    expect(
      inputOf(actOn(older(['cover']), 'version'), 'voice'),
    ).toBeUndefined();
    expect(actsOf(older([]))).toEqual([]);
  });

  it('takes a node that declares acts at its word, even none', () => {
    const declared = { ...older(['cover', 'extend']), acts: [] };
    expect(actsOf(declared)).toEqual([]);
  });

  it('keeps the same three acts the node builds in', () => {
    expect(BUILT_IN_ACTS.map(act => [act.id, act.needs])).toEqual([
      ['version', 'cover'],
      ['longer', 'extend'],
      ['hum', 'cover'],
    ]);
  });
});

describe('the words for an act', () => {
  it('keeps its own for the acts it knows and borrows the label for others', () => {
    expect(wordsForAct({ id: 'version', label: 'whatever' }).make).toBe(
      'Make a version',
    );
    const words = wordsForAct({ id: 'remix', label: 'A remix' });
    expect(words).toMatchObject({
      eyebrow: 'A REMIX',
      make: 'Make a remix',
      label: 'A remix',
      door: 'MAKES A REMIX',
    });
  });
});
