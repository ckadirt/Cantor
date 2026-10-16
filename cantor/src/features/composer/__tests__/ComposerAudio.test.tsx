import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { ComposerSheet } from '../ComposerSheet';
import type { Fact, FactReading } from '../../../facts';
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
  subject: 'a:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
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

describe("the Words row follows the song's lyrics fact", () => {
  const fact = (patch: Partial<Fact>): Fact => ({
    subject: song.subject,
    kind: 'lyrics',
    status: 'found',
    value: null,
    source: null,
    reason: null,
    checkedAtMs: 0,
    retryAtMs: null,
    ...patch,
  });

  function renderWith(reading: FactReading | null) {
    const retry = jest.fn();
    const onSubmit = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    const sheet = (next: FactReading | null) => (
      <GestureHandlerRootView>
        <ComposerSheet
          error={null}
          onClose={jest.fn()}
          onSubmit={onSubmit}
          recipe={{
            draft: draftFromSource({ ...song, words: null }),
            seed: 99,
          }}
          sourceWords={{ reading: next, retry }}
          submitting={false}
          targets={[agentbox]}
        />
      </GestureHandlerRootView>
    );
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(sheet(reading));
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
    const land = (next: FactReading | null) =>
      ReactTestRenderer.act(() => tree.update(sheet(next)));
    return { words, press, land, retry, onSubmit };
  }

  it('says it is looking, then turns to SAME when the words land, from where', () => {
    const { words, land, press, onSubmit } = renderWith({
      status: 'looking',
      previous: null,
    });
    expect(words()).toContain('LOOKING FOR ITS WORDS');
    expect(words()).not.toContain('SAME');

    land(fact({ value: 'the tide comes in', source: 'lrclib' }));
    expect(words()).toEqual(expect.arrayContaining(['SAME', 'FROM LRCLIB']));
    press('Make a version');
    expect(onSubmit.mock.calls[0]![2]).toMatchObject({
      lyrics: 'the tide comes in',
    });
  });

  it('says none were found, and sends the instrumental marker', () => {
    const { words } = renderWith(fact({ status: 'none' }));
    expect(words()).toContain('NO WORDS FOUND');
    expect(words()).not.toContain('SAME');
  });

  it('says LRCLIB is out of reach and offers to try again', () => {
    const { words, press, retry, land } = renderWith(
      fact({ status: 'unreachable', source: 'lrclib', retryAtMs: 60_000 }),
    );
    expect(words()).toContain("CAN'T REACH LRCLIB");
    press('Look for its words again');
    expect(retry).toHaveBeenCalledTimes(1);
    // Asked again: the same words until it answers.
    land({
      status: 'looking',
      previous: fact({ status: 'unreachable', source: 'lrclib' }),
    });
    expect(words()).toContain("CAN'T REACH LRCLIB");
  });

  it("says why there are none, in LRCLIB's terms", () => {
    expect(
      renderWith(fact({ status: 'none', reason: 'not-found' })).words(),
    ).toContain('NOT IN LRCLIB');
    expect(
      renderWith(fact({ status: 'none', reason: 'instrumental' })).words(),
    ).toContain('LRCLIB LISTS IT INSTRUMENTAL');
    expect(
      renderWith(fact({ status: 'none', reason: 'untagged' })).words(),
    ).toContain('NOTHING TO SEARCH BY');
    const busy = renderWith(
      fact({ status: 'unreachable', source: 'lrclib', reason: 'busy' }),
    ).words();
    expect(busy).toEqual(
      expect.arrayContaining(['LRCLIB IS BUSY', 'Try again']),
    );
  });

  it('keeps a choice of NONE when the words land after it', () => {
    const { words, press, land } = renderWith({
      status: 'looking',
      previous: null,
    });
    press('Words: my words');
    press('Words: none');
    land(fact({ value: 'the tide comes in', source: 'file-tags' }));
    expect(words()).toContain('THIS WILL BE INSTRUMENTAL');
  });

  it("starts MINE from the song's own words, to edit", () => {
    const { press, land, onSubmit } = renderWith({
      status: 'looking',
      previous: null,
    });
    land(fact({ value: 'the tide comes in', source: 'file-tags' }));
    press('Words: my words');
    press('Make a version');
    expect(onSubmit.mock.calls[0]![2]).toMatchObject({
      lyrics: 'the tide comes in',
    });
  });
});

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
        act_id: 'version',
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

describe('the composer draws an act from what it declares', () => {
  function renderOn(models: ModelView[], source: SongSource) {
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
            targets={[{ ...agentbox, models }]}
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
    return { words, press, onSubmit };
  }

  it('offers an act it has never heard of, in its catalog words and its inputs', () => {
    const remixer: ModelView = {
      ...ace,
      acts: [
        {
          id: 'remix',
          label: 'A remix',
          needs: 'cover',
          sources: ['song'],
          inputs: [
            { kind: 'follow', stops: [0, 1] },
            { kind: 'prompt', required: false, default: 'A remix of it' },
          ],
        },
      ],
    };
    const { words, press, onSubmit } = renderOn([remixer], {
      ...song,
      act: 'remix',
      prompt: '',
    });
    expect(words()).toEqual(
      expect.arrayContaining(['COMPOSE · A REMIX', 'FOLLOW', 'CLOSE', 'FREE']),
    );
    // Only what it declares: no Voice, no Words, no Between.
    expect(words()).not.toContain('VOICE');
    expect(words()).not.toContain('WORDS');
    expect(words()).not.toContain('BETWEEN');
    press('Follow: free. A song that remembers it');
    press('Make a remix');
    expect(onSubmit.mock.calls[0][2]).toEqual({
      caption: 'A remix of it',
      seed: 99,
      audio: {
        source: { kind: 'song', song_id: song.songId },
        act: 'cover',
        act_id: 'remix',
        closeness: 1,
      },
    });
  });

  it('makes a version with an empty prompt, sending the act’s default', () => {
    const { press, onSubmit } = renderOn([ace], {
      ...song,
      prompt: '',
      words: null,
    });
    press('Make a version');
    expect(onSubmit.mock.calls[0][2]).toMatchObject({
      caption: 'The same song, its own style and instruments',
      audio: { act_id: 'version' },
    });
  });

  it('still asks for a prompt where the act requires one', () => {
    const { press, onSubmit } = renderOn([ace], {
      ...song,
      act: 'longer',
      prompt: '',
    });
    press('Make it longer');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
