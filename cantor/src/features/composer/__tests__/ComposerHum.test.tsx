import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { ComposerSheet } from '../ComposerSheet';
import type { ModelView } from '../../../core/protocol';
import type { NodeLimits } from '../../../../../protocol/NodeLimits';
import type { ComposerTarget } from '../draft';
import type { TuneRecorderPort } from '../../../audio/tuneRecorder';

const limits: NodeLimits = {
  max_concurrent_jobs: 1,
  max_queued_jobs_per_principal: 4,
  min_song_seconds: 15,
  max_song_seconds: 600,
  max_caption_bytes: 500,
  max_lyrics_bytes: 5000,
  max_page_limit: 100,
};
const ace: ModelView = {
  selector: 'acestep:1.5-fast',
  family: 'acestep',
  engine: 'acestep',
  capabilities: [{ kind: 'cover', stages: ['diffuse', 'decode'] }],
};
const agentbox: ComposerTarget = {
  nodePublicKey: 'a',
  label: 'agentbox',
  ready: true,
  models: [ace],
  limits,
  takesAudio: true,
  takesUploads: true,
};

function fakeRecorder(seconds: number) {
  let hear: ((semitone: number | null, at: number) => void) | null = null;
  const recorder: TuneRecorderPort = {
    start: jest.fn(async onPitch => {
      hear = onPitch;
    }),
    stop: jest.fn(async () => ({
      path: '/cache/takes/tune-1.wav',
      seconds,
      mediaType: 'audio/wav' as const,
      sha256: 'c'.repeat(64),
      bytes: 480_044,
    })),
    cancel: jest.fn(async () => {}),
    listen: jest.fn(async () => () => {}),
  };
  return {
    recorder,
    sing: (semitone: number | null, at: number) => hear?.(semitone, at),
  };
}

function render(
  recorder: TuneRecorderPort,
  targets: readonly ComposerTarget[] = [agentbox],
) {
  const onSubmit = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GestureHandlerRootView>
        <ComposerSheet
          askForMicrophone={async () => 'granted'}
          error={null}
          onClose={jest.fn()}
          onSubmit={onSubmit}
          recorder={recorder}
          submitting={false}
          targets={targets}
        />
      </GestureHandlerRootView>,
    );
  });
  const words = () =>
    tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
  const type = async (label: string, value: string) => {
    const input = tree.root.find(
      node =>
        typeof node.props.onChangeText === 'function' &&
        node.props.accessibilityLabel === label,
    );
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText(value);
    });
  };
  const press = async (label: string) => {
    const target = tree.root.find(
      node =>
        typeof node.type !== 'string' &&
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === label,
    );
    await ReactTestRenderer.act(async () => {
      target.props.onPress();
    });
  };
  return { onSubmit, words, press, type };
}

describe('Hum a song', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('counts in, records a tune, and sends a song that starts from it', async () => {
    const { recorder, sing } = fakeRecorder(9.5);
    const { words, press, onSubmit, type } = render(recorder);
    await press('Start from a tune');
    expect(words()).toEqual(
      expect.arrayContaining([
        'COMPOSE · A TUNE',
        'PRESS TO RECORD',
        'TEMPO',
        'AS HUMMED',
      ]),
    );
    expect(words()).toContain('Record a tune first.');

    await press('Record a tune');
    expect(words()).toContain('COUNTING IN');
    // Four beats at 96 bpm, then the recorder starts.
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(4 * 625 + 10);
    });
    expect(recorder.start).toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      sing(0, 0.1);
      sing(2, 0.2);
      sing(null, 0.3);
    });

    await press('Stop recording');
    expect(recorder.stop).toHaveBeenCalled();
    expect(words()).toContain('0:10 · PRESS TO LISTEN');

    await press('Length: a full song');
    expect(words()).not.toContain("the model's choice");
    await type('Describe the song', 'warm acoustic pop');
    await press('Make a song');
    const [node, model, request, source] = onSubmit.mock.calls[0];
    expect([node, model]).toEqual(['a', 'acestep:1.5-fast']);
    expect(request.audio).toEqual({
      source: { kind: 'upload', upload_id: 'pending' },
      act: 'cover',
      closeness: 0.5,
      tune: true,
      tile_to_seconds: 120,
    });
    expect(request).not.toHaveProperty('duration');
    expect(source).toEqual({
      path: '/cache/takes/tune-1.wav',
      mediaType: 'audio/wav',
      sha256: 'c'.repeat(64),
      bytes: 480_044,
    });
  });

  it('refuses a take shorter than three seconds', async () => {
    const { recorder } = fakeRecorder(1.2);
    const { words, press } = render(recorder);
    await press('Start from a tune');
    await press('Tempo: free');
    await press('Record a tune');
    await press('Stop recording');
    expect(words()).toContain('A little longer: 3 seconds at least.');
  });

  it('does not offer a tune where no node can take one', () => {
    const { recorder } = fakeRecorder(5);
    const { words } = render(recorder, [{ ...agentbox, takesUploads: false }]);
    expect(words()).not.toContain('START FROM');
  });
});
