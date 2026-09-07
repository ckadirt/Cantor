/**
 * The measurement draws itself on, and only once you have arrived.
 *
 * The ring is the one part of the player with no pose at L1 to come from — a
 * row has no waveform — so it is written on rather than transformed, with the
 * motion engine's own per-item lag. What matters is that it waits: a
 * measurement drawing itself during the descent is one more thing moving in a
 * frame that already has the face growing and two lines morphing in it.
 */
import React from 'react';
import { Path } from '@shopify/react-native-skia';
import ReactTestRenderer from 'react-test-renderer';
import { PLAYER_RING_KNOBS, PlayerRing } from '../NativePlayer';

const levels = Array.from({ length: 64 }, (_, index) =>
  0.2 + 0.1 * Math.sin(index),
);

/** The bars are the only path here rebuilt from the draw-on clock. */
function barCommandsAt(drawn: number): number {
  const shared = { value: drawn };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <PlayerRing
        colour="#000000"
        drawn={shared as never}
        durationSeconds={10}
        levels={levels}
        positionSeconds={{ value: 0 } as never}
        radius={120}
      />,
    );
  });
  const paths = renderer.root
    .findAllByType(Path)
    .map(node => node.props.path as { value?: { toCmds?: () => unknown[] } })
    .filter(path => typeof path?.value?.toCmds === 'function');
  return paths[0]!.value!.toCmds!().length;
}

describe('the player ring writes its measurement on', () => {
  it('draws nothing before the descent has settled', () => {
    expect(barCommandsAt(0)).toBe(0);
  });

  it('draws every tick once the clock has run', () => {
    // One move and one line per tick; `toCmds` reports them as two commands.
    expect(barCommandsAt(1)).toBe(PLAYER_RING_KNOBS.SONG_WAVE_TICKS * 2);
  });

  /**
   * And it arrives in order, which is what makes it a gesture rather than a
   * fade. Partway through, some ticks are drawn and the rest are not yet —
   * `writeSubAlpha` gives each its own slice of one clock.
   */
  it('sweeps rather than appearing all at once', () => {
    const half = barCommandsAt(0.5);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(PLAYER_RING_KNOBS.SONG_WAVE_TICKS * 2);
  });
});
