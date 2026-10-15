import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { ComposerSheet } from '../ComposerSheet';
import type { ModelView } from '../../../core/protocol';
import type { NodeLimits } from '../../../../../protocol/NodeLimits';
import {
  draftFromSource,
  type SongSource,
  type ComposerTarget,
} from '../draft';

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
  stages: ['plan', 'codes', 'diffuse', 'decode'],
  capabilities: [
    { kind: 'cover', stages: ['diffuse', 'decode'] },
    { kind: 'extend', stages: ['diffuse', 'decode'], max_total_seconds: 600 },
    { kind: 'timbre' },
  ],
};
const levo: ModelView = {
  selector: 'levo2:1.0',
  family: 'levo2',
  engine: 'levo2',
  capabilities: [],
};

const agentbox: ComposerTarget = {
  nodePublicKey: 'a',
  label: 'agentbox',
  ready: true,
  models: [ace, levo],
  limits,
  takesAudio: true,
  takesUploads: true,
};

const song: SongSource = {
  kind: 'song',
  act: 'version',
  songId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  nodePublicKey: 'a',
  title: 'Harbour at dusk',
  durationMs: 192_000,
  prompt: 'a slow harbour at dusk',
  words: 'the tide comes in',
  seed: 7,
  model: 'acestep:1.5-fast',
};

function render(source: SongSource) {
  const onSubmit = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GestureHandlerRootView>
        <ComposerSheet
          error={null}
          onClose={jest.fn()}
          onSubmit={onSubmit}
          recipe={{ draft: draftFromSource(source), seed: 99 }}
          submitting={false}
          targets={[agentbox]}
        />
      </GestureHandlerRootView>,
    );
  });
  const words = () =>
    tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
  const press = (label: string) => {
    const target = tree.root.find(
      node =>
        typeof node.type !== 'string' &&
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === label,
    );
    ReactTestRenderer.act(() => target.props.onPress());
  };
  const type = (label: string, value: string) => {
    const input = tree.root.find(
      node =>
        typeof node.props.onChangeText === 'function' &&
        node.props.accessibilityLabel === label,
    );
    ReactTestRenderer.act(() => input.props.onChangeText(value));
  };
  return { onSubmit, words, press, type };
}

describe('the composer, starting from a song', () => {
  it('draws a version: its source, Follow, Voice and words, and the length as a fact', () => {
    const { words } = render(song);
    expect(words()).toEqual(
      expect.arrayContaining([
        'COMPOSE · A VERSION',
        'FROM',
        'Harbour at dusk',
        'FOLLOW',
        'VOICE',
        'The same singer, the same room',
        'As long as the song',
        '3:12',
        'agentbox',
      ]),
    );
    // A text-only model is not offered for a version.
    expect(words()).not.toContain('levo2:1.0');
    // The planner never runs for an audio act: no Write words.
    expect(words()).not.toContain('WRITE WORDS');
  });

  it('sends a cover of the song, and a changed prompt asks for a new voice', () => {
    const { onSubmit, press, type } = render(song);
    press('Follow: close. The same song, changed');
    type('Describe the song', 'sung by a woman, acoustic guitar');
    press('Make a version');
    expect(onSubmit).toHaveBeenCalledWith('a', 'acestep:1.5-fast', {
      caption: 'sung by a woman, acoustic guitar',
      lyrics: 'the tide comes in',
      seed: 99,
      audio: {
        source: { kind: 'song', song_id: song.songId },
        act: 'cover',
        closeness: 0,
      },
    });
  });

  it('draws a longer song as time added and where, and sends an extension', () => {
    const { words, press, onSubmit } = render({ ...song, act: 'longer' });
    expect(words()).toEqual(
      expect.arrayContaining(['COMPOSE · LONGER', 'ADD', 'WHERE']),
    );
    expect(words()).not.toContain('FOLLOW');
    press('Add it at the start');
    press('Make it longer');
    expect(onSubmit.mock.calls[0][2]).toMatchObject({
      audio: { act: 'extend', extend_seconds: 90, extend_at: 'start' },
    });
    expect(onSubmit.mock.calls[0][2]).not.toHaveProperty('duration');
  });
});
