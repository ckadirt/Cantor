import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { ComposerSheet } from '../ComposerSheet';
import type { NodeLimits } from '../../../../../protocol/NodeLimits';
import type { ComposerTarget } from '../draft';

const limits: NodeLimits = {
  max_concurrent_jobs: 1,
  max_queued_jobs_per_principal: 4,
  min_song_seconds: 10,
  max_song_seconds: 240,
  max_caption_bytes: 500,
  max_lyrics_bytes: 5000,
  max_page_limit: 100,
};

const model = (selector: string) => ({
  selector,
  family: selector.split(':')[0],
  engine: selector.split(':')[0],
});

const agentbox: ComposerTarget = {
  nodePublicKey: 'a',
  label: 'agentbox',
  ready: true,
  models: [model('acestep:1.5-fast'), model('levo2:1.0')],
  limits,
};

const phone: ComposerTarget = {
  nodePublicKey: 'b',
  label: 'this phone',
  ready: true,
  models: [model('levo2:1.0')],
  limits,
};

function render(targets: readonly ComposerTarget[]) {
  const onSubmit = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ComposerSheet
        error={null}
        onClose={jest.fn()}
        onSubmit={onSubmit}
        submitting={false}
        targets={targets}
      />,
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
  const type_ = (label: string, value: string) => {
    const input = tree.root.find(
      node =>
        typeof node.props.onChangeText === 'function' &&
        node.props.accessibilityLabel === label,
    );
    ReactTestRenderer.act(() => input.props.onChangeText(value));
  };
  return { onSubmit, words, press, type: type_ };
}

describe('the composer Ledger', () => {
  it('shows the resolved machine without opening a drawer', () => {
    const { words } = render([
      { ...agentbox, models: [model('acestep:1.5-fast')] },
    ]);
    expect(words()).toEqual(
      expect.arrayContaining([
        'ENGINE',
        'MODEL',
        'LENGTH',
        'WORDS',
        'agentbox',
        'acestep:1.5-fast',
      ]),
    );
  });
  it('retains typed lyrics across words choices and sends only mine', () => {
    const { press, type, onSubmit } = render([agentbox]);
    type('Describe the song', 'harbour');
    press('Write my lyrics');
    type('Lyrics', 'the tide goes out');
    press('No lyrics');
    press('Write my lyrics');
    press('Make it');
    expect(onSubmit.mock.calls[0][2]).toMatchObject({
      lyrics: 'the tide goes out',
    });
  });
  it('offers a separate Write words switch only for a capable model', () => {
    const capable: ComposerTarget = {
      ...agentbox,
      models: [
        {
          ...model('acestep:1.5-fast'),
          stages: ['plan', 'codes', 'diffuse', 'decode'],
        },
        model('levo2:1.0'),
      ],
    };
    const { press, type, words, onSubmit } = render([capable]);
    type('Describe the song', 'harbour');
    expect(words()).toContain('WRITE WORDS');
    expect(words()).not.toContain("ACESTEP'S");
    press('Generate lyrics automatically');
    press('Write words: off');
    expect(words()).toContain('THIS WILL BE INSTRUMENTAL');
    press('Generate lyrics automatically');
    press('Make it');
    expect(onSubmit.mock.calls[0][2]).toEqual({
      caption: 'harbour',
    });
    press('Generate lyrics automatically');
    press('Run it with levo2:1.0');
    expect(words()).not.toContain('WRITE WORDS');
    expect(words()).toContain('NO LYRICS SUPPLIED');
  });

  it('does not submit an empty mine selection', () => {
    const { press, type, onSubmit } = render([agentbox]);
    type('Describe the song', 'harbour');
    press('Write my lyrics');
    press('Make it');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/**
 * The defect this step exists to remove: the old composer merged every paired
 * node's models into one list, so a model only one node had could be selected
 * against a node that did not have it — and `problemsWith` then reported
 * `model-not-installed` as though it were the person's mistake.
 */
describe('a pairing the node cannot run is never offered', () => {
  it('offers only the chosen node’s models', () => {
    const { words, press } = render([agentbox, phone]);

    press('Run it on this phone');

    expect(words()).toContain('THE ONLY MODEL THIS PHONE HAS.');
    // ACE-Step belongs to the other node and must not be on offer here, in
    // either the dial's chrome casing or the sheet's own.
    expect(words()).not.toContain('acestep:1.5-fast');
    expect(words()).not.toContain('ACESTEP:1.5-FAST');
    // One model is not a dial: the step states what it resolved to.
    expect(words()).toContain('levo2:1.0');
  });

  it('sends the model that belongs to the node it sends to', () => {
    const { onSubmit, press, type } = render([agentbox, phone]);
    type('Describe the song', 'a slow harbour at dusk');
    press('Run it on this phone');
    press('Make it');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [nodePublicKey, modelSelector] = onSubmit.mock.calls[0];
    expect(nodePublicKey).toBe('b');
    expect(modelSelector).toBe('levo2:1.0');
  });
});
