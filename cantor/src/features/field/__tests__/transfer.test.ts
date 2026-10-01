import { transferOf } from '../useFieldController';

describe('what a download is doing', () => {
  const partial = { state: 'partial' as const, bytes: 4 };
  const remote = { state: 'remote' as const, bytes: 0 };
  it('splits arriving into moving and held, and says what waits', () => {
    expect(transferOf(partial, true, null)).toBe('moving');
    expect(transferOf(partial, false, 'waiting')).toBe('held');
    expect(transferOf(partial, false, null)).toBe('stopped');
    expect(transferOf(remote, false, 'waiting')).toBe('waiting');
    expect(transferOf(partial, false, 'changed')).toBe('changed');
    expect(transferOf(remote, false, null)).toBeNull();
  });
});
