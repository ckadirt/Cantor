/**
 * The keyboard takes its band out of the sheet, and out of nothing else.
 *
 * The window used to resize for it. That moved `viewportHeight`, which is the
 * blind's whole travel and the number the field behind it is laid out on — so
 * one keyboard re-ran a sheet's height animation, the field's plan, and every
 * seat measured inside the open panel, all on the same frame.
 */
import React from 'react';
import { DeviceEventEmitter, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import * as Renderer from 'react-test-renderer';
import { Curtain } from '../Curtain';

const VIEWPORT = 800;
const KEYBOARD = 300;

function Harness() {
  const pull = useSharedValue(-VIEWPORT);
  const destination = useSharedValue(-VIEWPORT);
  return (
    <GestureHandlerRootView>
      <Curtain
        edge="bottom"
        destination={destination}
        onClose={() => {}}
        open
        pull={pull}
        title="ENGINES"
        viewportHeight={VIEWPORT}
      >
        <Text>the sheet</Text>
      </Curtain>
    </GestureHandlerRootView>
  );
}

function keyboard(height: number) {
  Renderer.act(() => {
    DeviceEventEmitter.emit(
      height > 0 ? 'keyboardDidShow' : 'keyboardDidHide',
      {
        endCoordinates: {
          screenX: 0,
          screenY: VIEWPORT - height,
          width: 400,
          height,
        },
      },
    );
  });
}

/** Every style laid on a view of this tree, flattened in render order. */
function styles(tree: Renderer.ReactTestRenderer): Record<string, unknown>[] {
  return tree.root
    .findAll(node => node.type === View && Array.isArray(node.props.style))
    .flatMap(node => node.props.style as unknown[])
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object',
    );
}

/** The blind itself: the clipping surface, as far down as it has come. */
function blind(tree: Renderer.ReactTestRenderer) {
  const found = styles(tree).filter(
    entry => entry.opacity !== undefined && entry.height !== undefined,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

/** The sheet standing on it, which is the only thing that is ever squeezed. */
function sheet(tree: Renderer.ReactTestRenderer) {
  const found = styles(tree).filter(
    entry => entry.backgroundColor !== undefined && entry.height !== undefined,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

describe('a blind under an open keyboard', () => {
  afterEach(() => keyboard(0));

  it('keeps the screen for its height and pays the band out of its content', () => {
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(<Harness />);
    });
    expect(blind(tree)).toMatchObject({ height: VIEWPORT });
    expect(sheet(tree)).toMatchObject({
      height: VIEWPORT,
      paddingBottom: 0,
    });

    keyboard(KEYBOARD);
    // Neither height moves — that is the whole fix. Only the room left inside
    // the sheet changes, which is where its own foot and its acts live.
    expect(blind(tree)).toMatchObject({ height: VIEWPORT });
    expect(sheet(tree)).toMatchObject({
      height: VIEWPORT,
      paddingBottom: KEYBOARD,
    });

    keyboard(0);
    expect(sheet(tree)).toMatchObject({ paddingBottom: 0 });
  });

  it('opens over a keyboard that is already up', () => {
    // A panel opened from another panel's text field arrives to a keyboard
    // that has already announced itself, and no second `keyboardDidShow` is
    // coming for it.
    Renderer.act(() => {
      Renderer.create(<Harness />);
    });
    keyboard(KEYBOARD);

    let second!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      second = Renderer.create(<Harness />);
    });
    expect(sheet(second)).toMatchObject({ paddingBottom: KEYBOARD });
  });
});
