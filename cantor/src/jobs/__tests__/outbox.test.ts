import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadOutbox, markAccepted, markRejected, putPending } from '../outbox';

describe('submission outbox', () => {
  beforeEach(async () => AsyncStorage.clear());

  it('persists the frozen request before it can be sent', async () => {
    const generation = { caption: 'slow bolero', duration: 60 };
    const pending = await putPending('node', 'acestep:1.5-fast', generation);
    generation.caption = 'edited later';
    expect((await loadOutbox())[0]).toMatchObject({
      clientRequestId: pending.clientRequestId,
      state: 'pending',
      generation: { caption: 'slow bolero' },
    });
  });

  it('keeps the idempotency mapping after acceptance', async () => {
    const pending = await putPending('node', 'model', { caption: 'one' });
    await markAccepted(pending.clientRequestId, 'job-1');
    expect((await loadOutbox())[0]).toMatchObject({
      state: 'accepted',
      canonicalJobId: 'job-1',
    });
  });

  it('serializes concurrent updates without dropping another submission', async () => {
    const [first, second] = await Promise.all([
      putPending('node', 'model', { caption: 'one' }),
      putPending('node', 'model', { caption: 'two' }),
    ]);
    await Promise.all([
      markAccepted(first.clientRequestId, 'job-1'),
      markRejected(second.clientRequestId, 'invalid request'),
    ]);
    const entries = await loadOutbox();
    expect(entries).toHaveLength(2);
    expect(
      entries.find(entry => entry.clientRequestId === first.clientRequestId),
    ).toMatchObject({
      state: 'accepted',
      canonicalJobId: 'job-1',
    });
    expect(
      entries.find(entry => entry.clientRequestId === second.clientRequestId),
    ).toMatchObject({
      state: 'rejected',
      lastError: 'invalid request',
    });
  });

  it('detects a persisted payload changed without its hash', async () => {
    await putPending('node', 'model', { caption: 'original' });
    const key = 'cantor.submission-outbox.v1';
    const entries = JSON.parse((await AsyncStorage.getItem(key)) ?? '[]');
    entries[0].generation.caption = 'tampered';
    await AsyncStorage.setItem(key, JSON.stringify(entries));
    await expect(loadOutbox()).rejects.toThrow('hash does not match');
  });
});
