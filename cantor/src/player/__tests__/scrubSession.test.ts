import { createScrubSession } from '../scrubSession';
import { FakePlayer } from '../fakePlayer';

const track = { nodeKey: 'node', songId: 'song', digest: 'digest' };

async function fixture(playing = true) {
  const player = new FakePlayer({ durationOf: () => 120 });
  await player.load(track, '/song');
  if (playing) await player.play();
  const preview = jest.fn();
  const seek = jest.spyOn(player, 'seek');
  return { player, preview, seek, scrub: createScrubSession(player, preview) };
}

it('silences the whole drag and commits only the final destination before resuming', async () => {
  const { player, preview, seek, scrub } = await fixture();
  for (const second of [10, 30, 60]) scrub.update(second);
  expect(player.snapshot().state).toBe('paused');
  expect(seek).not.toHaveBeenCalled();
  expect(preview).toHaveBeenLastCalledWith(60);
  await player.advance(1000);
  expect(player.snapshot().positionSeconds).toBe(0);
  await Promise.all([scrub.finish(), scrub.finish()]);
  expect(seek).toHaveBeenCalledTimes(1);
  expect(player.snapshot()).toMatchObject({ state: 'playing', positionSeconds: 60 });
});

it('preserves paused playback and clamps the preview to the track', async () => {
  const { player, preview, scrub } = await fixture(false);
  scrub.update(999);
  expect(preview).toHaveBeenLastCalledWith(120);
  await scrub.finish();
  expect(player.snapshot()).toMatchObject({ state: 'paused', positionSeconds: 120 });
});

it('does not seek or resume a replacement track', async () => {
  const { player, seek, scrub } = await fixture();
  scrub.update(60);
  await player.load({ ...track, songId: 'replacement' }, '/other');
  await scrub.finish();
  expect(seek).not.toHaveBeenCalled();
  expect(player.snapshot().state).toBe('paused');
  expect(scrub.active).toBe(false);
});

it('waits for native pause and abandons a cancelled transaction', async () => {
  const { player, seek, scrub } = await fixture();
  let paused!: () => void;
  jest.spyOn(player, 'pause').mockImplementation(() => new Promise(resolve => { paused = resolve; }));
  scrub.update(60);
  const finishing = scrub.finish();
  expect(seek).not.toHaveBeenCalled();
  scrub.cancel();
  paused();
  await finishing;
  expect(seek).not.toHaveBeenCalled();
});
