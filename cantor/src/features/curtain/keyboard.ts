import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

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
