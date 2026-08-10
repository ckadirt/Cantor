import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { ArtifactView } from '../../../../../protocol/ArtifactView';
import type { SongDetail } from '../../../../../protocol/SongDetail';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import { LibrarySongRow, LibraryTimeline } from '..';
import type {
  LibraryRow,
  LibrarySongRowProps,
  LibraryTimelineProps,
} from '../types';

const artifact: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 900,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};

function song(revision = 1, title = 'First song'): SongHeader {
  return {
    id: '019fe1cb-a56a-7591-a7c1-2d577c1d01fc',
    revision,
    title,
    caption_summary: 'Quiet piano',
    created_at: '2026-08-08T00:00:00Z',
    duration_ms: 8_000,
    model: 'light',
    favorite: false,
    tags: ['calm'],
    trashed: false,
    artifacts: [artifact],
  };
}

function row(overrides: Partial<LibraryRow> = {}): LibraryRow {
  return {
    backend: {
      nodePubkey: 'node-a',
      relayUrl: 'wss://relay.example',
      petname: 'Studio',
      lastNodeInfo: null,
    },
    song: song(),
    delivery: artifact,
    local: { state: 'remote', bytes: 0 },
    availableOffline: false,
    ready: true,
    nodeLabels: ['Studio', 'node-a'],
    ...overrides,
  };
}

function callbacks(): LibraryTimelineProps {
  return {
    rows: [],
    onDetail: jest.fn(),
    onPatch: jest.fn().mockResolvedValue(undefined),
    onPresence: jest.fn().mockResolvedValue(undefined),
    onAudio: jest.fn().mockResolvedValue(undefined),
    onError: jest.fn(),
  };
}

function rowProps(overrides: Partial<LibrarySongRowProps> = {}) {
  const shared = callbacks();
  return {
    row: row(),
    onDetail: shared.onDetail,
    onPatch: shared.onPatch,
    onPresence: shared.onPresence,
    onAudio: shared.onAudio,
    onError: shared.onError,
    ...overrides,
  } satisfies LibrarySongRowProps;
}

describe('library presentation extraction', () => {
  it('preserves the empty-library explanation', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LibraryTimeline {...callbacks()} rows={[]} />,
      );
    });

    expect(renderedText(renderer)).toContain(
      'Completed songs will appear here without downloading their audio.',
    );
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: 'Search private library',
      }),
    ).toHaveLength(0);
  });

  it('keeps search local and shows the existing no-match message', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LibraryTimeline {...callbacks()} rows={[row()]} />,
      );
    });
    const search = renderer.root.findByProps({
      accessibilityLabel: 'Search private library',
    });

    await ReactTestRenderer.act(async () =>
      search.props.onChangeText('absent'),
    );

    expect(renderedText(renderer)).toContain(
      'No cached songs match this local view.',
    );
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Song title' }),
    ).toHaveLength(0);
  });

  it('submits the trimmed title and parsed tags through the unchanged patch contract', async () => {
    const props = rowProps();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<LibrarySongRow {...props} />);
    });
    const title = renderer.root.findByProps({
      accessibilityLabel: 'Song title',
    });
    const tags = renderer.root.findByProps({ accessibilityLabel: 'Song tags' });
    await ReactTestRenderer.act(async () => {
      title.props.onChangeText('  Renamed  ');
      tags.props.onChangeText(' calm, , night ');
    });

    await ReactTestRenderer.act(async () =>
      press(renderer, 'SAVE').props.onPress(),
    );

    expect(props.onPatch).toHaveBeenCalledWith('node-a', props.row.song, {
      title: 'Renamed',
      tags: ['calm', 'night'],
    });
  });

  it('keeps audio busy timing and resets loaded detail when the song revision changes', async () => {
    const pendingAudio = deferred<void>();
    const fullDetail: SongDetail = {
      song: song(),
      generation: {
        caption: 'Full private request',
        lyrics: 'verse',
        seed: 7,
        steps: 12,
      },
      engine: 'acestep.cpp',
      component_digests: ['digest'],
      attempts: 2,
    };
    const props = rowProps({
      onAudio: jest.fn(() => pendingAudio.promise),
      onDetail: jest.fn().mockResolvedValue(fullDetail),
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<LibrarySongRow {...props} />);
    });

    await ReactTestRenderer.act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Download and play audio' })
        .props.onPress();
      await Promise.resolve();
    });
    expect(props.onAudio).toHaveBeenCalledWith(
      'node-a',
      props.row.song,
      artifact,
      'download-play',
    );
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Download and play audio',
      }).props.disabled,
    ).toBe(true);
    expect(renderedText(renderer)).toContain('0%');

    await ReactTestRenderer.act(async () => {
      pendingAudio.resolve();
      await pendingAudio.promise;
    });
    await ReactTestRenderer.act(async () =>
      press(renderer, 'DETAILS').props.onPress(),
    );
    expect(renderedText(renderer)).toContain('Full private request');

    const nextProps = {
      ...props,
      row: row({ song: song(2, 'Remote revision') }),
    };
    await ReactTestRenderer.act(async () => {
      renderer.update(<LibrarySongRow {...nextProps} />);
    });

    expect(renderedText(renderer)).not.toContain('Full private request');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Song title' }).props
        .value,
    ).toBe('Remote revision');
  });
});

function press(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
): ReactTestRenderer.ReactTestInstance {
  const labelNode = renderer.root
    .findAllByType(Text)
    .find(instance => textContent(instance.props.children) === label);
  let match = labelNode?.parent;
  while (
    match !== undefined &&
    match !== null &&
    typeof match.props.onPress !== 'function'
  ) {
    match = match.parent;
  }
  if (match === undefined || match === null) {
    throw new Error(`Could not find ${label} button.`);
  }
  return match;
}

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(instance => textContent(instance.props.children))
    .join('\n');
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return Array.isArray(value) ? value.map(textContent).join('') : '';
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
