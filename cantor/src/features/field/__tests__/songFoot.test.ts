import { touch } from '../../../theme/tokens';
import { LENS_PICKER_KNOBS } from '../../song/LensPicker';
import { PLAYER_POSE_KNOBS } from '../songPose';
import { OVERLAY_KNOBS } from '../FieldOverlay';

/**
 * The foot of L2, read as the stack of touch bands it really is.
 *
 * Four controls share the bottom 180 px of the screen and not one of them is
 * laid out relative to the next: the transport and the quiet line are drawn on
 * the canvas from `PLAYER_POSE_KNOBS` and caught by boxes centred on their
 * seats, the picker is a React row, and the rolled engines blind is chrome that
 * belongs to no level at all. They only ever met through `hitSlop`, which is
 * invisible, so every collision down here has looked like nothing at all and
 * behaved like the wrong control answering.
 *
 * Two of them shipped: the bottom third of `DETAIL` opened the engines, and the
 * bottom third of the play triangle changed the lens. Both were padding into a
 * neighbour's row rather than into air.
 *
 * So the bands are written out here in one place, in the one unit they share —
 * pixels up from the bottom edge — and held in order. Any knob in any of the
 * four files can be retuned; the one that closes a gap is the one that fails.
 */
describe('the L2 foot, band by band', () => {
  /** The rolled engines blind: body from the edge, plus its inward slop. */
  const tab = {
    from: 0,
    to:
      OVERLAY_KNOBS.TAB_EDGE_INSET_PX +
      OVERLAY_KNOBS.TAB_REACH_PX +
      OVERLAY_KNOBS.TAB_HIT_INWARD_PX,
  };

  /** `DETAIL` and `PINNED`: a `touch.min` box centred on the baseline. */
  const words = {
    from: PLAYER_POSE_KNOBS.SONG_WORDS_BOTTOM_PX - touch.min / 2,
    to: PLAYER_POSE_KNOBS.SONG_WORDS_BOTTOM_PX + touch.min / 2,
  };

  /** The lens picker: a row that hugs its ink, with slop either side of it. */
  const picker = {
    from: PLAYER_POSE_KNOBS.SONG_LENS_BOTTOM_PX - LENS_PICKER_KNOBS.HIT_DOWN_PX,
    to:
      PLAYER_POSE_KNOBS.SONG_LENS_BOTTOM_PX +
      LENS_PICKER_KNOBS.ROW_PX +
      LENS_PICKER_KNOBS.HIT_UP_PX,
  };

  /** The transport: a square centred on the row's own centre line. */
  const transport = {
    from:
      PLAYER_POSE_KNOBS.SONG_TRANSPORT_BOTTOM_PX -
      PLAYER_POSE_KNOBS.SONG_TRANSPORT_HIT_PX / 2,
    to:
      PLAYER_POSE_KNOBS.SONG_TRANSPORT_BOTTOM_PX +
      PLAYER_POSE_KNOBS.SONG_TRANSPORT_HIT_PX / 2,
  };

  it.each([
    ['the engines tab', 'the player’s quiet line', tab, words],
    ['the player’s quiet line', 'the lens picker', words, picker],
    ['the lens picker', 'the transport', picker, transport],
  ])('keeps %s clear of %s', (_lower, _upper, lower, upper) => {
    expect(lower.to).toBeLessThan(upper.from);
  });

  /**
   * And each of them is still something a thumb can land on.
   *
   * The transport keeps `touch.min` exactly. The tab is short of it in the
   * drawing but sits against the screen edge, where its outward slop runs into
   * an edge a thumb overshoots anyway. The picker is the one that is genuinely
   * small, and it is small because the gap it lives in is — see
   * `LENS_PICKER_KNOBS`.
   */
  it('leaves every control a band worth pressing', () => {
    expect(transport.to - transport.from).toBe(touch.min);
    expect(words.to - words.from).toBe(touch.min);
    expect(
      OVERLAY_KNOBS.TAB_REACH_PX +
        OVERLAY_KNOBS.TAB_HIT_SLOP_PX +
        OVERLAY_KNOBS.TAB_HIT_INWARD_PX,
    ).toBeGreaterThanOrEqual(touch.min);
    expect(picker.to - picker.from).toBeGreaterThanOrEqual(28);
  });

  /**
   * The drawing, not the targets: the three groups the foot is meant to read
   * as. The picker belongs with the quiet line under it, so it must not end up
   * nearer the transport than the line — which is exactly what happened when
   * its seat and its ink were 19 px apart.
   */
  it('seats the picker nearer its own line than the transport', () => {
    const toTransport =
      PLAYER_POSE_KNOBS.SONG_TRANSPORT_BOTTOM_PX -
      (PLAYER_POSE_KNOBS.SONG_LENS_BOTTOM_PX + LENS_PICKER_KNOBS.ROW_PX);
    const toWords =
      PLAYER_POSE_KNOBS.SONG_LENS_BOTTOM_PX -
      PLAYER_POSE_KNOBS.SONG_WORDS_BOTTOM_PX;
    expect(toWords).toBeLessThan(toTransport);
  });
});
