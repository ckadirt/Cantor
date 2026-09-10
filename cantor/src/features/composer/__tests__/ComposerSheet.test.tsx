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

describe('the composer collapses the machine into one line', () => {
  it('resolves the alpha case and says why it needs no attention', () => {
    const { words } = render([{ ...agentbox, models: [model('acestep:1.5-fast')] }]);

    expect(words()).toContain('AGENTBOX · ACESTEP:1.5-FAST · AUTO');
    // Prose, in the app's own serif: what is *said about* the machine is a
    // sentence, and only the machine's own state is set in the chrome's mono.
    expect(words()).toContain('One engine, one model — tap to change.');
  });

  it('counts what the chosen node has, once the cascade is open', () => {
    const { words, press } = render([agentbox, phone]);

    press('Change engine, model and length');
    // With two nodes paired nothing is preselected: the first step is a real
    // question, and the second only answers itself once it has been answered.
    press('Run it on agentbox');
    expect(words()).toContain('The 2 models agentbox has.');
    expect(words()).toContain('WHERE IT RUNS');
    expect(words()).toContain('WHAT RUNS IT');
    expect(words()).toContain('HOW LONG');
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
    press('Change engine, model and length');

    press('Run it on this phone');

    expect(words()).toContain('The only model this phone has.');
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
    press('Change engine, model and length');
    press('Run it on this phone');
    press('Make it');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [nodePublicKey, modelSelector] = onSubmit.mock.calls[0];
    expect(nodePublicKey).toBe('b');
    expect(modelSelector).toBe('levo2:1.0');
  });
});
