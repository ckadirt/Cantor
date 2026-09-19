import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Path } from '@shopify/react-native-skia';
import { PlayerRing } from '../NativePlayer';

jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated'),
  // Preserve dependency semantics: native mappers keep their old closure
  // until this dependency list changes, even if React has new props.
  useDerivedValue: (updater: () => unknown, dependencies?: unknown[]) =>
    require('react').useMemo(() => ({ value: updater() }), dependencies ?? [updater]),
}));

it('rebinds the playhead when an idle song becomes the playing track', () => {
  const idle = { value: 0 };
  const playing = { value: 60 };
  const ring = (position: typeof idle) => (
    <PlayerRing radius={100} durationSeconds={120} positionSeconds={position as never} colour="black" />
  );
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => { renderer = ReactTestRenderer.create(ring(idle)); });
  expect(renderer.root.findAllByType(Path)[0].props.end.value).toBe(0);
  ReactTestRenderer.act(() => { renderer.update(ring(playing)); });
  expect(renderer.root.findAllByType(Path)[0].props.end.value).toBe(0.5);
  ReactTestRenderer.act(() => { renderer.update(ring(idle)); });
  expect(renderer.root.findAllByType(Path)[0].props.end.value).toBe(0);
});
