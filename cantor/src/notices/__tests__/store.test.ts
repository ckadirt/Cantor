import { describeError } from '../../core/protocol';
import { createNotices, NOTICE_KNOBS, type Notice } from '../store';

const notice = (key: string, action?: Notice['action']): Notice => ({
  key,
  tone: 'info',
  words: describeError('internal', 'Studio'),
  ...(action ? { action } : {}),
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('posts, replaces by key, and selects newest first', () => {
  const n = createNotices();
  const a = notice('a');
  const b = notice('b');
  n.post(a);
  n.post(b);
  expect(n.store.get()).toEqual([b, a]);
  const nextA = notice('a');
  n.post(nextA);
  expect(n.store.get()).toEqual([nextA, b]);
  n.clear('a');
  expect(n.store.get()).toEqual([b]);
  const state = n.store.get();
  n.clear('missing');
  expect(n.store.get()).toBe(state);
  n.clear('b');
  expect(n.store.get()).toEqual([]);
});

it('expires a notice only after its reading time, resetting replacement timers', () => {
  const n = createNotices();
  n.post(notice('a'));
  jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS - 1);
  expect(n.store.get()).toHaveLength(1);
  n.post(notice('a'));
  jest.advanceTimersByTime(1);
  expect(n.store.get()).toHaveLength(1);
  jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS - 1);
  expect(n.store.get()).toEqual([]);
});

it('holds an action until run, then clears it', () => {
  const n = createNotices();
  const run = jest.fn();
  const a = notice('a', { label: 'TRY AGAIN', run });
  n.post(a);
  jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS * 5);
  expect(n.store.get()).toEqual([a]);
  n.act(a);
  expect(run).toHaveBeenCalledTimes(1);
  expect(n.store.get()).toEqual([]);
  n.act(a);
  expect(run).toHaveBeenCalledTimes(1);
});

it('waits while the player owns the foot', () => {
  const n = createNotices();
  n.setAvailable(false);
  n.post(notice('a'));
  jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS * 5);
  expect(n.store.get()).toHaveLength(1);
  n.setAvailable(true);
  jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS);
  expect(n.store.get()).toEqual([]);
});

it('keeps a replacement posted synchronously by the action', () => {
  const n = createNotices();
  const replacement = notice('a');
  const a = notice('a', { label: 'AGAIN', run: () => n.post(replacement) });
  n.post(a);
  n.act(a);
  expect(n.store.get()).toEqual([replacement]);
});
