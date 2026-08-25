import { NativeModules } from 'react-native';
import {
  inspectNativeAudio,
  nativeAudio,
  resolveNativeAudioPath,
} from '../native';

type NativeAudioMock = {
  localState: jest.Mock;
  appendChunk: jest.Mock;
  finalizeDownload: jest.Mock;
  pin: jest.Mock;
  unpin: jest.Mock;
  removeCached: jest.Mock;
  localPath: jest.Mock;
  play: jest.Mock;
  stop: jest.Mock;
  enforceCacheBudget: jest.Mock;
};

function createNativeAudioMock(): NativeAudioMock {
  return {
    localState: jest.fn(),
    appendChunk: jest.fn(),
    finalizeDownload: jest.fn(),
    pin: jest.fn(),
    unpin: jest.fn(),
    removeCached: jest.fn(),
    localPath: jest.fn(),
    play: jest.fn(),
    stop: jest.fn(),
    enforceCacheBudget: jest.fn(),
  };
}

describe('CantorAudio native adapter characterization', () => {
  let bridge: NativeAudioMock;

  beforeEach(() => {
    bridge = createNativeAudioMock();
    (NativeModules as { CantorAudio?: NativeAudioMock }).CantorAudio = bridge;
  });

  afterEach(() => {
    delete (NativeModules as { CantorAudio?: NativeAudioMock }).CantorAudio;
  });

  it.each([
    ['remote', 0],
    ['partial', 17],
    ['cached', 80],
    ['pinned', 100],
  ] as const)('accepts the native %s state', async (state, bytes) => {
    bridge.localState.mockResolvedValue({ state, bytes });

    await expect(inspectNativeAudio('node', 'song', 'digest')).resolves.toEqual(
      {
        state,
        bytes,
      },
    );
    expect(bridge.localState).toHaveBeenCalledWith('node', 'song', 'digest');
  });

  it.each([
    null,
    {},
    { state: 'unknown', bytes: 1 },
    { state: 'cached', bytes: -1 },
    { state: 'cached', bytes: 1.5 },
    { state: 'cached', bytes: '1' },
  ])('rejects an invalid native state result %#', async value => {
    bridge.localState.mockResolvedValue(value);

    await expect(inspectNativeAudio('node', 'song', 'digest')).rejects.toThrow(
      'Native audio state is invalid.',
    );
  });

  it('keeps the React Native method names and argument order stable', async () => {
    bridge.appendChunk.mockResolvedValue(9);
    bridge.finalizeDownload.mockResolvedValue(true);
    bridge.pin.mockResolvedValue(true);
    bridge.unpin.mockResolvedValue(true);
    bridge.removeCached.mockResolvedValue(true);
    bridge.play.mockResolvedValue(true);
    bridge.stop.mockResolvedValue(true);
    bridge.enforceCacheBudget.mockResolvedValue(['digest']);

    await expect(
      nativeAudio.appendChunk('node', 'song', 'digest', 3, 'data'),
    ).resolves.toBe(9);
    await nativeAudio.finalize('node', 'song', 'digest', 9);
    await nativeAudio.pin('node', 'song', 'digest');
    await nativeAudio.unpin('node', 'song', 'digest');
    await nativeAudio.remove('node', 'song', 'digest');
    await nativeAudio.play('node', 'song', 'digest');
    await nativeAudio.stop();
    await expect(nativeAudio.enforceCacheBudget(256)).resolves.toEqual([
      'digest',
    ]);

    expect(bridge.appendChunk).toHaveBeenCalledWith(
      'node',
      'song',
      'digest',
      3,
      'data',
    );
    expect(bridge.finalizeDownload).toHaveBeenCalledWith(
      'node',
      'song',
      'digest',
      9,
    );
    expect(bridge.pin).toHaveBeenCalledWith('node', 'song', 'digest');
    expect(bridge.unpin).toHaveBeenCalledWith('node', 'song', 'digest');
    expect(bridge.removeCached).toHaveBeenCalledWith('node', 'song', 'digest');
    expect(bridge.play).toHaveBeenCalledWith('node', 'song', 'digest');
    expect(bridge.stop).toHaveBeenCalledWith();
    expect(bridge.enforceCacheBudget).toHaveBeenCalledWith(256);
  });

  it('fails explicitly when the native module is absent', async () => {
    delete (NativeModules as { CantorAudio?: NativeAudioMock }).CantorAudio;

    await expect(inspectNativeAudio('node', 'song', 'digest')).rejects.toThrow(
      'The native Cantor audio module is unavailable.',
    );
  });

  it('returns the verified path the native module resolved', async () => {
    bridge.localPath.mockResolvedValue('/data/cantor-audio/cache/song.opus');

    await expect(resolveNativeAudioPath('node', 'song', 'digest')).resolves.toBe(
      '/data/cantor-audio/cache/song.opus',
    );
    expect(bridge.localPath).toHaveBeenCalledWith('node', 'song', 'digest');
  });

  it.each([[''], [null], [undefined], [42], [{}]])(
    'rejects %p as a local audio path',
    async value => {
      bridge.localPath.mockResolvedValue(value);

      await expect(
        resolveNativeAudioPath('node', 'song', 'digest'),
      ).rejects.toThrow('Native audio path is invalid.');
    },
  );

  it('surfaces a native refusal to resolve a path', async () => {
    bridge.localPath.mockRejectedValue(
      new Error('Download the artifact before playing it.'),
    );

    await expect(
      nativeAudio.localPath('node', 'song', 'digest'),
    ).rejects.toThrow('Download the artifact before playing it.');
  });
});
