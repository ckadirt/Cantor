import React from 'react';
import { Text, TextInput } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { NodeInfo } from '../../../../../protocol/NodeInfo';
import type {
  BackendRecord,
  ConnectionSnapshot,
} from '../../../backends/types';
import { BackendCard, phaseLabel } from '../BackendCard';

const node: NodeInfo = {
  name: 'Studio node',
  device_type: 'desktop',
  engine_version: 'test',
  models: [{ selector: 'light', family: 'ace-step', engine: 'acestep.cpp' }],
  limits: {
    max_concurrent_jobs: 1,
    max_queued_jobs_per_principal: 4,
    min_song_seconds: 1,
    max_song_seconds: 240,
    max_caption_bytes: 1_024,
    max_lyrics_bytes: 8_192,
    max_page_limit: 100,
  },
  load: { active_jobs: 0, queued_jobs: 0, accepting_jobs: true },
  features: {
    jobs_create: true,
    library_list: true,
    artifacts_transfer: true,
    secure_tunnel: true,
    job_controls: true,
  },
};

const backend: BackendRecord = {
  nodePubkey: '11111111-2222-4333-8444-555555555555',
  relayUrl: 'wss://relay.example',
  petname: 'Studio',
  lastNodeInfo: node,
};

const snapshot: ConnectionSnapshot = {
  phase: 'ready',
  error: null,
  jobs: [],
  songs: [],
  libraryRevision: null,
  librarySyncing: false,
};

describe('backend card presentation', () => {
  it('preserves the connection phase labels', () => {
    expect(phaseLabel('disconnected')).toBe('DISCONNECTED');
    expect(phaseLabel('connecting')).toBe('CONNECTING');
    expect(phaseLabel('attached')).toBe('NODE OFFLINE');
    expect(phaseLabel('handshaking')).toBe('VERIFYING');
    expect(phaseLabel('ready')).toBe('READY');
  });

  it('submits the normalized draft, locks during the request, and resets only draft fields on success', async () => {
    let resolveSubmission!: () => void;
    const submission = new Promise<void>(resolve => {
      resolveSubmission = resolve;
    });
    const onSubmit = jest.fn(() => submission);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <BackendCard
          backend={backend}
          snapshot={snapshot}
          readyBackground="#eff8f0"
          readyBorder="#73a97b"
          onSubmit={onSubmit}
          onJobControl={jest.fn()}
        />,
      );
    });

    expect(renderedText(renderer)).toContain('Studio node');
    expect(renderedText(renderer)).toContain('1 concurrent · 240s max');
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(true);

    ReactTestRenderer.act(() => {
      pressableWithLabel(renderer, 'light').props.onPress();
      const inputs = renderer.root.findAllByType(TextInput);
      inputs[0].props.onChangeText('  quiet song  ');
      inputs[1].props.onChangeText('la la');
      inputs[2].props.onChangeText('12x');
    });
    expect(renderer.root.findAllByType(TextInput)[2].props.value).toBe('12');
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(false);

    ReactTestRenderer.act(() => {
      pressableWithLabel(renderer, 'Submit').props.onPress();
    });
    expect(onSubmit).toHaveBeenCalledWith(backend.nodePubkey, 'light', {
      caption: 'quiet song',
      lyrics: 'la la',
      duration: 12,
    });
    expect(renderedText(renderer)).toContain('Submitting…');
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(true);

    await ReactTestRenderer.act(async () => {
      resolveSubmission();
      await submission;
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByType(TextInput).map(input => input.props.value),
    ).toEqual(['', '', '']);
    expect(renderedText(renderer)).toContain('Queued');
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.root.findAllByType(TextInput)[0].props.onChangeText('again');
    });
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(false);
  });

  it('preserves the waiting and snapshot error copy without node capabilities', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <BackendCard
          backend={{ ...backend, lastNodeInfo: null }}
          snapshot={{ ...snapshot, phase: 'attached', error: 'relay failed' }}
          readyBackground="#eff8f0"
          readyBorder="#73a97b"
          onSubmit={jest.fn()}
          onJobControl={jest.fn()}
        />,
      );
    });

    expect(renderedText(renderer)).toContain(
      'Waiting for the first authenticated capability response.',
    );
    expect(renderedText(renderer)).toContain('relay failed');
    expect(renderedText(renderer)).toContain('NODE OFFLINE');
  });

  it('keeps duration and UTF-8 byte limits in the submit disabled rule', () => {
    const limitedBackend: BackendRecord = {
      ...backend,
      lastNodeInfo: {
        ...node,
        limits: {
          ...node.limits,
          max_caption_bytes: 4,
          max_lyrics_bytes: 4,
        },
      },
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <BackendCard
          backend={limitedBackend}
          snapshot={snapshot}
          readyBackground="#eff8f0"
          readyBorder="#73a97b"
          onSubmit={jest.fn()}
          onJobControl={jest.fn()}
        />,
      );
    });
    ReactTestRenderer.act(() => {
      pressableWithLabel(renderer, 'light').props.onPress();
      renderer.root.findAllByType(TextInput)[0].props.onChangeText('ééé');
    });
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(true);

    ReactTestRenderer.act(() => {
      const inputs = renderer.root.findAllByType(TextInput);
      inputs[0].props.onChangeText('song');
      inputs[2].props.onChangeText('241');
    });
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(true);

    ReactTestRenderer.act(() => {
      const inputs = renderer.root.findAllByType(TextInput);
      inputs[2].props.onChangeText('240');
      inputs[1].props.onChangeText('🎵🎵');
    });
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.root.findAllByType(TextInput)[1].props.onChangeText('');
    });
    expect(pressableWithLabel(renderer, 'Submit').props.disabled).toBe(false);
  });
});

function pressableWithLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
): ReactTestRenderer.ReactTestInstance {
  const labelNodes = renderer.root
    .findAllByType(Text)
    .filter(item => textContent(item.props.children) === label);
  for (const labelNode of labelNodes) {
    let result = labelNode.parent;
    while (result !== null && typeof result.props.onPress !== 'function') {
      result = result.parent;
    }
    if (result !== null) return result;
  }
  throw new Error(`Missing pressable ${label}.`);
}

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(item => textContent(item.props.children))
    .join('|');
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return Array.isArray(value) ? value.map(textContent).join('') : '';
}
