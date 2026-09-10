import { unrollTo } from '../Curtain';

/**
 * The mock's `withTiming` returns its target, so a shared value written by
 * `unrollTo` here holds where the run was headed rather than where it is
 * partway through — which is the only thing these tests are asking about.
 */
const shared = (value: number) => ({ value }) as any;

describe('unrollTo', () => {
  it('sends a blind to its target and records where it is headed', () => {
    const pull = shared(0);
    const destination = shared(0);

    unrollTo(pull, destination, 800, 1);

    expect(destination.value).toBe(800);
    expect(pull.value).toBe(800);
  });

  it('leaves a run already headed there alone', () => {
    const pull = shared(320);
    const destination = shared(800);

    unrollTo(pull, destination, 800, 1);

    expect(pull.value).toBe(320);
  });

  // The keyboard: the soft input shrinks the viewport, both blinds re-run with
  // the new height, and the one that is rolled up asks for zero. It shares the
  // open blind's value, so without the sign test it rolled the composer away
  // the moment a caption got a caret.
  it('does not roll away the blind hanging at the other edge', () => {
    const pull = shared(800);
    const destination = shared(800);

    unrollTo(pull, destination, 0, -1);

    expect(pull.value).toBe(800);
    expect(destination.value).toBe(800);
  });

  it('still resizes the blind that is hanging', () => {
    const pull = shared(800);
    const destination = shared(800);

    unrollTo(pull, destination, 540, 1);

    expect(pull.value).toBe(540);
    expect(destination.value).toBe(540);
  });

  it('still folds a blind away by its own edge', () => {
    const pull = shared(-800);
    const destination = shared(-800);

    unrollTo(pull, destination, 0, -1);

    expect(pull.value).toBe(0);
    expect(destination.value).toBe(0);
  });
});
