import React from 'react';
import * as Renderer from 'react-test-renderer';
import { NodeRequestError } from '../../../backends/connection';
import { describeFailure } from '../../../core/protocol';
import { notices } from '../../../notices';
import { useFieldNotices } from '../useFieldNotices';
import type { BackendRuntimeState } from '../../../runtime/backendRuntime';
import type { CondensingSubmission } from '../../composer/useSubmission';

function mount() {
  let runAudio!: ReturnType<typeof useFieldNotices>;
  let condensing: CondensingSubmission | null = {
    caption: 'Rain',
    jobKey: 'node:work',
  };
  const setCondensing = (
    update: (
      current: CondensingSubmission | null,
    ) => CondensingSubmission | null,
  ) => {
    condensing = update(condensing);
  };
  function Harness({
    failure,
    runtimeError = null,
  }: {
    failure: BackendRuntimeState['submissionFailure'];
    runtimeError?: string | null;
  }) {
    runAudio = useFieldNotices({
      submissionFailure: failure,
      runtimeError,
      failureWords: describeFailure,
      nodeNameOf: () => 'agentbox',
      setCondensing,
    });
    return null;
  }
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(<Harness failure={null} />);
  });
  return {
    tree,
    runAudio: (...args: Parameters<typeof runAudio>) => runAudio(...args),
    getCondensing: () => condensing,
    fail: (failure: BackendRuntimeState['submissionFailure']) => {
      Renderer.act(() => tree.update(<Harness failure={failure} />));
    },
    runtime: (runtimeError: string | null) => {
      Renderer.act(() =>
        tree.update(<Harness failure={null} runtimeError={runtimeError} />),
      );
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const notice of notices.store.get()) notices.clear(notice.key);
  jest.useRealTimers();
});

it.each(['download', 'keep', 'remove'])(
  'FieldScreen audio %s failure posts a retry of the same action',
  async () => {
    const f = mount();
    const command = jest
      .fn()
      .mockRejectedValueOnce(new Error('Timed out'))
      .mockResolvedValue(undefined);
    await Renderer.act(async () => {
      await f.runAudio('node:song', 'node', command);
    });
    const notice = notices.store.get()[0];
    expect(notice).toMatchObject({
      key: 'audio:node:song',
      words: { short: 'agentbox did not answer' },
      action: { label: 'TRY AGAIN' },
    });
    await Renderer.act(async () => {
      notices.act(notice);
    });
    expect(command).toHaveBeenCalledTimes(2);
    expect(notices.store.get()).toEqual([]);
    Renderer.act(() => f.tree.unmount());
  },
);

it('posts a later submission refusal after the composer has closed, and releases its caption', () => {
  const f = mount();
  const failure = {
    workKey: 'node:work',
    nodePublicKey: 'node',
    error: new NodeRequestError('refused', 'invalid_request', false),
  };
  f.fail(failure);
  const notice = notices.store.get()[0];
  expect(notice).toMatchObject({ key: 'work:node:work', tone: 'refusal' });
  expect(notice.action).toBeUndefined();
  expect(f.getCondensing()).toBeNull();
  // A renamed node or a later render cannot replay an already consumed failure.
  notices.clear(notice.key);
  f.fail(failure);
  expect(notices.store.get()).toEqual([]);
  Renderer.act(() => f.tree.unmount());
});

it('a retry that fails again stands as a new notice', async () => {
  const f = mount();
  const command = jest.fn().mockRejectedValue(new Error('Timed out'));
  await Renderer.act(async () => {
    await f.runAudio('song', 'node', command);
  });
  const before = notices.store.get()[0];
  await Renderer.act(async () => {
    notices.act(before);
  });
  expect(command).toHaveBeenCalledTimes(2);
  expect(notices.store.get()[0]).not.toBe(before);
  expect(notices.store.get()[0].key).toBe(before.key);
  Renderer.act(() => f.tree.unmount());
});

it("the runtime's background failure is a notice while it lasts", () => {
  const f = mount();
  f.runtime('Saved nodes could not be read.');
  const notice = notices.store.get().find(each => each.key === 'runtime');
  expect(notice).toMatchObject({ tone: 'info' });
  expect(notice?.action).toBeUndefined();
  f.runtime(null);
  expect(notices.store.get().some(each => each.key === 'runtime')).toBe(false);
});
