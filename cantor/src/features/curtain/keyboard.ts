import { useEffect, useState, type Component } from 'react';
import {
  findNodeHandle,
  Keyboard,
  TextInput,
  type GestureResponderEvent,
} from 'react-native';

/**
 * A finger landing anywhere but the focused input puts the keyboard down.
 *
 * Wired as `onStartShouldSetResponderCapture` on a view that holds one input
 * among things to touch (the field and its overlay, where find's query
 * lives). Capture runs before any child sees the touch, and it answers false,
 * so it claims nothing and the gesture under the finger still runs: a tap on
 * a song opens it with the keyboard already on its way down, rather than the
 * player rising under a keyboard.
 *
 * The sheets do not need it: their staves are scroll views that already
 * dismiss on a tap nothing handles, and they hold several inputs, where
 * putting the keyboard down between two of them would flicker it.
 */
export function releaseKeyboardOutside(event: GestureResponderEvent): boolean {
  const focused = TextInput.State.currentlyFocusedInput();
  if (focused == null) return false;
  // On Fabric the event's target is the host instance; the native tag is the
  // same answer on the old renderer.
  const target: unknown = event.target;
  if (target === focused) return false;
  const tag = findNodeHandle(focused as unknown as Component);
  if (tag != null && Number(event.nativeEvent.target) === tag) return false;
  Keyboard.dismiss();
  return false;
}

/**
 * How much of the sheet's foot the soft keyboard is standing on, in dp.
 *
 * The window does not resize for it — the activity asks for `adjustNothing` —
 * so the keyboard is something drawn *over* the app rather than something that
 * changes the app's shape. That is the whole point of this hook existing: the
 * field's layout, a blind's travel and every seat measured inside a sheet are
 * all derived from the viewport, and a viewport that shrank under an open
 * sheet re-ran all three at once. A blind is the height of the screen whether
 * or not a keyboard is up; what the keyboard covers, it covers of the sheet's
 * content, and only while it is up.
 *
 * Android reports this already netted against the navigation bar, which is
 * exactly the band the sheet sits above, so the number is the overlap as it
 * is. On iOS it runs to the bottom of the screen and so overshoots by one
 * safe-area inset, which costs a little air under the keyboard and nothing
 * else.
 */
export function useKeyboardInset(): number {
  // Seeded rather than started at zero: a sheet can be opened over a keyboard
  // that is already up — tapping a name in one panel to open another — and it
  // would otherwise wait for a `keyboardDidShow` that is not coming.
  const [inset, setInset] = useState(() => Keyboard.metrics()?.height ?? 0);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', event => {
      setInset(event.endCoordinates.height);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setInset(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return inset;
}
