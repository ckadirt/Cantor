import React from 'react';
import * as Renderer from 'react-test-renderer';
import { describeFailure } from '../../../core/protocol';
import type { BackendRuntimeCommands } from '../../../runtime/backendRuntime';
import { useSubmission } from '../useSubmission';

function mount(submit: BackendRuntimeCommands['submit']) {
  let current!: ReturnType<typeof useSubmission>;
  const closeComposer = jest.fn();
  function Harness() {
    current = useSubmission({
      submit,
      closeComposer,
      failureWords: describeFailure,
      nodeNameOf: () => 'Studio',
    });
    return null;
  }
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(<Harness />);
  });
  return { get: () => current, closeComposer, tree };
}

it('condenses onto the key returned for this Make, before any node job exists', async () => {
  let saved!: (key: string) => void;
  const submit = jest.fn(
    () =>
      new Promise<string>(resolve => {
        saved = resolve;
      }),
  );
  const f = mount(submit);
  let done!: Promise<void>;
  Renderer.act(() => {
    done = f.get().submitDraft('node', 'model', { caption: 'My rain' });
  });
  expect(f.get().submitting).toBe(true);
  expect(f.closeComposer).toHaveBeenCalledTimes(1);
  expect(f.get().condensing).toEqual({ caption: 'My rain', jobKey: null });
  const submittedKey = 'node:84d20840-bb28-89ac-b6ff-e3c358b93eb7';
  await Renderer.act(async () => {
    saved(submittedKey);
    await done;
  });
  expect(f.get().condensing).toEqual({
    caption: 'My rain',
    jobKey: submittedKey,
  });
  expect(f.get().submitting).toBe(false);
  expect(f.get().submitError).toBeNull();
  Renderer.act(() => f.tree.unmount());
});

it('releases the caption only when saving fails', async () => {
  const f = mount(async () => {
    throw new Error('Disk full');
  });
  await Renderer.act(async () => {
    await f.get().submitDraft('node', 'model', { caption: 'Rain' });
  });
  expect(f.get().condensing).toBeNull();
  expect(f.get().submitError).not.toBeNull();
  expect(f.get().submitting).toBe(false);
  Renderer.act(() => f.tree.unmount());
});
