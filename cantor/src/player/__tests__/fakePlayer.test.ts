import type { AudioRef } from '../../audio/localAudioStore';
import { FakePlayer } from '../fakePlayer';
import { describePlayerContract } from '../playerContract';
import { sameTrack } from '../types';

const FIRST: AudioRef = {
  nodeKey: 'node-a',
  songId: '11111111-1111-4111-8111-111111111111',
  digest: 'a'.repeat(64),
};

const SECOND: AudioRef = {
  nodeKey: 'node-b',
  songId: '22222222-2222-4222-8222-222222222222',
  digest: 'b'.repeat(64),
};

const PATHS: Record<string, number> = {
  '/audio/first.opus': 120,
  '/audio/second.opus': 45,
};

describePlayerContract('FakePlayer', () => {
  const player = new FakePlayer({
    durationOf: path => PATHS[path] ?? 180,
    loadFailure: path =>
      path === '/audio/corrupt.opus' ? 'Local artifact is corrupt.' : null,
  });
  return {
    player,
    advance: ms => player.advance(ms),
    track: { ref: FIRST, localPath: '/audio/first.opus', durationSeconds: 120 },
    other: { ref: SECOND, localPath: '/audio/second.opus', durationSeconds: 45 },
    failingPath: '/audio/corrupt.opus',
  };
});

describe('sameTrack', () => {
  it('matches on the full node/song/digest identity', () => {
    expect(sameTrack(FIRST, { ...FIRST })).toBe(true);
    expect(sameTrack(FIRST, SECOND)).toBe(false);
  });

  it('treats a different digest of the same song as a different track', () => {
    expect(sameTrack(FIRST, { ...FIRST, digest: 'c'.repeat(64) })).toBe(false);
  });

  it('does not consider two absent tracks a match with a present one', () => {
    expect(sameTrack(null, null)).toBe(true);
    expect(sameTrack(FIRST, null)).toBe(false);
    expect(sameTrack(null, FIRST)).toBe(false);
  });
});

describe('FakePlayer clock', () => {
  it('does not advance a paused track', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    await player.load(FIRST, '/audio/first.opus');
    await player.advance(5000);
    expect(player.snapshot().positionSeconds).toBe(0);
  });

  it('keeps position anchored across a pause/resume pair', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    await player.load(FIRST, '/audio/first.opus');
    await player.play();
    await player.advance(3000);
    await player.pause();
    await player.advance(10000);
    await player.play();
    await player.advance(2000);
    expect(player.snapshot().positionSeconds).toBeCloseTo(5, 3);
  });

  it('publishes an ended snapshot exactly once when the track runs out', async () => {
    const player = new FakePlayer({ durationOf: () => 10 });
    const states: string[] = [];
    await player.load(FIRST, '/audio/first.opus');
    player.subscribe(s => states.push(s.state));
    await player.play();
    await player.advance(20000);
    await player.advance(5000);
    expect(states.filter(s => s === 'ended')).toHaveLength(1);
  });
});
