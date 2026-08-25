export { AudioApiPlayer } from './audioApiPlayer';
export type {
  AudioApiPlayerDeps,
  AudioElementHandle,
  ElementBinding,
  NowPlaying,
} from './audioApiPlayer';
export { createAudioApiPlayer } from './createAudioApiPlayer';
export { PlayerHost } from './PlayerHost';
export { FakePlayer, type FakePlayerOptions } from './fakePlayer';
export { usePlayer, type NowPlayingInfo, type PlayerController } from './usePlayer';
export { planVisualClock, type ClockPlan } from './visualClock';
export {
  EMPTY_SNAPSHOT,
  sameTrack,
  type ChannelWindow,
  type PlayerPort,
  type PlayerSnapshot,
  type PlayerState,
  type SampleRequest,
  type SampleWindow,
} from './types';
