import type { JobView } from '../../../core/protocol';
import type {
  BackendRecord,
  ConnectionSnapshot,
} from '../../../backends/types';
import { knownModels, nodeStateWord, variantLabel } from '../nodeState';

const snapshot = (
  phase: ConnectionSnapshot['phase'],
  states: JobView['state'][] = [],
): ConnectionSnapshot => ({
  phase,
  error: null,
  jobs: states.map(state => ({ state } as JobView)),
  songs: [],
  libraryRevision: null,
  librarySyncing: false,
});

describe('a node, said as a person would', () => {
  it('never lets a connection phase reach the screen', () => {
    expect(nodeStateWord(undefined)).toBe('OFFLINE');
    expect(nodeStateWord(snapshot('disconnected'))).toBe('OFFLINE');
    expect(nodeStateWord(snapshot('attached'))).toBe('OFFLINE');
    expect(nodeStateWord(snapshot('connecting'))).toBe('CONNECTING');
    expect(nodeStateWord(snapshot('handshaking'))).toBe('CONNECTING');
    expect(nodeStateWord(snapshot('ready'))).toBe('READY');
  });

  it('is making a song only while a job of this phone is under way', () => {
    expect(nodeStateWord(snapshot('ready', ['running']))).toBe('MAKING A SONG');
    expect(nodeStateWord(snapshot('ready', ['queued', 'running']))).toBe(
      'MAKING 2 SONGS',
    );
    expect(nodeStateWord(snapshot('ready', ['completed', 'failed']))).toBe(
      'READY',
    );
  });

  it('keeps which node each model was seen on', () => {
    const node = (key: string, selectors: string[]): BackendRecord =>
      ({
        nodePubkey: key,
        petname: key,
        relayUrl: '',
        lastNodeInfo: {
          models: selectors.map(selector => ({
            selector,
            family: selector.split(':')[0],
            engine: selector.split(':')[0],
          })),
        },
      } as unknown as BackendRecord);
    const known = knownModels([
      node('a', ['acestep:1.5-fast']),
      node('b', ['acestep:1.5-fast', 'levo2:1.0-quality']),
    ]);
    expect(known.get('acestep:1.5-fast')?.on).toEqual(['a', 'b']);
    expect(known.get('levo2:1.0-quality')?.on).toEqual(['b']);
    expect(variantLabel(known.get('acestep:1.5-fast')!.model)).toBe(
      '1.5 · fast',
    );
  });
});
