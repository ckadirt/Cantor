import { DEFAULT_BACKEND_SNAPSHOT, keepSnapshot } from '../backendRuntime';

describe('keepSnapshot', () => {
  const base = { ...DEFAULT_BACKEND_SNAPSHOT, ahead: { job: 3 } };

  it('lets a change that is only a place in the queue through', () => {
    const next = { ...base, ahead: { job: 2 } };
    expect(keepSnapshot(base, next)).toBe(next);
  });

  it('keeps the old snapshot when the node repeats the same places', () => {
    expect(keepSnapshot(base, { ...base, ahead: { job: 3 } })).toBe(base);
  });

  it('reads no places and an empty answer as the same thing', () => {
    const none = { ...DEFAULT_BACKEND_SNAPSHOT };
    expect(keepSnapshot(none, { ...none, ahead: {} })).toBe(none);
  });
});
