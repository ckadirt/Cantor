import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { JobView } from '../../../../../protocol/JobView';
import { JobQueue, jobControls, jobStateLabel, shortKey } from '../JobQueue';

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    revision: 3,
    state: 'queued',
    model: 'acestep:fast',
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:01:00Z',
    ...overrides,
  };
}

describe('job presentation', () => {
  it('preserves control availability and every specialized state label', () => {
    expect(jobControls(job())).toEqual(['pause', 'cancel']);
    expect(jobControls(job({ state: 'preparing' }))).toEqual([
      'pause',
      'cancel',
    ]);
    expect(jobControls(job({ state: 'running' }))).toEqual(['pause', 'cancel']);
    expect(jobControls(job({ state: 'pause_requested' }))).toEqual(['cancel']);
    expect(jobControls(job({ state: 'paused' }))).toEqual(['resume', 'cancel']);
    expect(
      jobControls(
        job({
          state: 'failed',
          error: { code: 'internal', message: 'failed', retryable: true },
        }),
      ),
    ).toEqual(['retry']);
    expect(
      jobControls(
        job({
          state: 'failed',
          error: { code: 'internal', message: 'failed', retryable: false },
        }),
      ),
    ).toEqual([]);
    expect(jobControls(job({ state: 'completed' }))).toEqual([]);

    expect(jobStateLabel(job({ state: 'running', stage: 'plan' }))).toBe(
      'Writing plan',
    );
    expect(jobStateLabel(job({ state: 'running', stage: 'codes' }))).toBe(
      'Generating codes',
    );
    expect(jobStateLabel(job({ state: 'running', stage: 'diffuse' }))).toBe(
      'Shaping audio',
    );
    expect(jobStateLabel(job({ state: 'running', stage: 'decode' }))).toBe(
      'Decoding',
    );
    expect(jobStateLabel(job({ state: 'paused', stage: 'codes' }))).toBe(
      'Paused during codes',
    );
    expect(jobStateLabel(job({ state: 'queued' }))).toBe('Waiting on node');
    expect(jobStateLabel(job({ state: 'preparing' }))).toBe('Preparing model');
    expect(jobStateLabel(job({ state: 'finalizing' }))).toBe('Saving song');
    expect(jobStateLabel(job({ state: 'pause_requested' }))).toBe(
      'Pausing at a safe point',
    );
    expect(jobStateLabel(job({ state: 'paused', stage: undefined }))).toBe(
      'Paused',
    );
    expect(jobStateLabel(job({ state: 'cancel_requested' }))).toBe(
      'Cancelling at a safe point',
    );
    expect(jobStateLabel(job({ state: 'cancelled' }))).toBe(
      'Generation cancelled',
    );
    expect(jobStateLabel(job({ state: 'completed' }))).toBe(
      'Generation complete',
    );
    expect(jobStateLabel(job({ state: 'failed' }))).toBe('Generation failed');
    expect(jobStateLabel(job({ state: 'recovering' }))).toBe(
      'Restarting from request',
    );
    expect(shortKey('11111111-2222-4333-8444-555555555555')).toBe(
      '11111111…555555',
    );
  });

  it('keeps controls disabled offline and renders the offline fallback', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <JobQueue
          jobs={[job()]}
          online={false}
          controlsSupported
          onControl={jest.fn()}
        />,
      );
    });

    expect(pressableWithLabel(renderer, 'PAUSE').props.disabled).toBe(true);
    expect(pressableWithLabel(renderer, 'CANCEL').props.disabled).toBe(true);
    expect(renderedText(renderer)).toContain('offline');
  });

  it('shows the pending control immediately, reports errors, and re-enables actions', async () => {
    let rejectControl!: (error: Error) => void;
    const controlResult = new Promise<void>((_resolve, reject) => {
      rejectControl = reject;
    });
    const onControl = jest.fn(() => controlResult);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <JobQueue
          jobs={[job()]}
          online
          controlsSupported
          onControl={onControl}
        />,
      );
    });
    const pause = pressableWithLabel(renderer, 'PAUSE');

    ReactTestRenderer.act(() => {
      pause.props.onPress();
    });
    expect(onControl).toHaveBeenCalledWith(job(), 'pause');
    expect(renderedText(renderer)).toContain('Requesting pause…');
    expect(pressableWithLabel(renderer, 'PAUSE').props.disabled).toBe(true);
    expect(pressableWithLabel(renderer, 'CANCEL').props.disabled).toBe(true);

    await ReactTestRenderer.act(async () => {
      rejectControl(new Error('control denied'));
      await controlResult.catch(() => undefined);
      await Promise.resolve();
    });
    expect(renderedText(renderer)).toContain('control denied');
    expect(renderedText(renderer)).toContain('Waiting on node');
    expect(pressableWithLabel(renderer, 'PAUSE').props.disabled).toBe(false);
    expect(pressableWithLabel(renderer, 'CANCEL').props.disabled).toBe(false);
  });
});

function pressableWithLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
): ReactTestRenderer.ReactTestInstance {
  const labelNode = renderer.root
    .findAllByType(Text)
    .find(item => textContent(item.props.children) === label);
  let result = labelNode?.parent;
  while (
    result !== undefined &&
    result !== null &&
    typeof result.props.onPress !== 'function'
  ) {
    result = result.parent;
  }
  if (result === undefined || result === null) {
    throw new Error(`Missing pressable ${label}.`);
  }
  return result;
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
