import { Skia } from '@shopify/react-native-skia';
import {
  BYLINE_MARQUEE_KNOBS,
  bylineEdgeStops,
  bylineLayout,
  bylineOffset,
  bylineSounding,
  bylineTailInk,
  stepByline,
} from '../BylineMarquee';
import { PLAYER_POSE_KNOBS, songTitleColumnPx } from '../songPose';
import { layoutText } from '../../../motion/text';

declare const __dirname: string;
const { readFileSync } = require('fs');
const { join } = require('path');

const viewport = { width: 392, height: 870 };
let font: ReturnType<typeof Skia.Font>;
beforeAll(() => {
  // A real face: the default one in CanvasKit has no glyph widths to measure.
  const data = readFileSync(
    join(__dirname, '../../../../assets/fonts/cmu-serif.ttf'),
  );
  const face = Skia.Typeface.MakeFreeTypeFaceFromData(
    Skia.Data.fromBytes(new Uint8Array(data)),
  );
  font = Skia.Font(face!, 11);
});

describe('byline layout', () => {
  it('leaves a byline that fits alone', () => {
    expect(bylineLayout('ARTIST · ALBUM', font, viewport).fits).toBe(true);
  });

  it('lays a long byline out as itself, a dot, and itself again', () => {
    const text = 'TIËSTO FEAT. ZAC BARNETT OF AMERICAN AUTHORS · A TOWN CALLED PARADISE';
    const layout = bylineLayout(text, font, viewport);
    if (layout.fits) throw new Error('expected to overflow');
    const once = layoutText(text, font, 0, Infinity, 0);
    const last = once[once.length - 1]!;
    const { scroll, boxes } = layout;

    expect(scroll.periodPx).toBeCloseTo(
      last.x + last.w + BYLINE_MARQUEE_KNOBS.GAP_PX,
    );
    // Two copies and the dot, the second copy exactly one period on: the
    // loop at `periodPx` is the loop at 0, which is what makes it seamless.
    expect(boxes).toHaveLength(once.length * 2 + 1);
    once.forEach((box, index) => {
      expect(boxes[once.length + 1 + index]!.x).toBeCloseTo(
        box.x + scroll.periodPx,
      );
    });
    const dot = boxes[once.length]!;
    expect(dot.x).toBeGreaterThan(last.x + last.w);
    expect(dot.x + dot.w).toBeLessThan(scroll.periodPx);
    // Seated at the column's left edge, so it lands reading from the start.
    expect(scroll.width).toBe(songTitleColumnPx(viewport.width));
    expect(scroll.left).toBe(-scroll.width / 2);
    // The letters past the column at rest are counted off from the rest.
    expect(scroll.shown).toBeGreaterThan(0);
    expect(scroll.shown).toBeLessThan(once.length);
    expect(boxes[scroll.shown - 1]!.x).toBeLessThan(scroll.width);
    expect(boxes[scroll.shown]!.x).toBeGreaterThanOrEqual(scroll.width);
  });

  it('inks the letters past the column in only as the line lands', () => {
    expect(bylineTailInk(0)).toBe(0);
    expect(bylineTailInk(0.5)).toBe(0);
    expect(bylineTailInk(BYLINE_MARQUEE_KNOBS.TAIL_FROM)).toBe(0);
    expect(bylineTailInk(0.9)).toBeGreaterThan(0);
    expect(bylineTailInk(0.9)).toBeLessThan(1);
    expect(bylineTailInk(1)).toBe(1);
  });
});

describe('byline clock', () => {
  const hold = BYLINE_MARQUEE_KNOBS.HOLD_MS / 1000;

  it('holds still, then travels at its speed', () => {
    let state = stepByline(0, 0, hold / 2);
    expect(state.travelled).toBe(0);
    // The frame that ends the hold does not move the line as well.
    state = stepByline(state.waited, state.travelled, hold);
    expect(state).toEqual({ waited: hold, travelled: 0 });
    state = stepByline(state.waited, state.travelled, 0.5);
    expect(state.travelled).toBeCloseTo(0.5 * BYLINE_MARQUEE_KNOBS.PX_PER_S);
  });

  it('wraps at the period', () => {
    expect(bylineOffset(0, 300)).toBe(0);
    expect(bylineOffset(310, 300)).toBeCloseTo(10);
    expect(bylineOffset(10, 0)).toBe(0);
  });

  it('runs only while the song sounds, easing with the verb', () => {
    expect(bylineSounding(0)).toBe(0); // waiting
    expect(bylineSounding(1)).toBe(0); // paused: the play silhouette
    expect(bylineSounding(1.5)).toBe(0.5);
    expect(bylineSounding(2)).toBe(1); // playing: the pause silhouette
  });
});

describe('byline edges', () => {
  it('fades only inside the side margin, leaving the column at full ink', () => {
    expect(BYLINE_MARQUEE_KNOBS.EDGE_FADE_PX).toBeLessThanOrEqual(
      PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX,
    );
    const column = { left: -172, width: 344 };
    const stops = bylineEdgeStops(column);
    const span = stops.to - stops.from;
    expect(stops.from + stops.positions[1]! * span).toBeCloseTo(column.left);
    expect(stops.from + stops.positions[2]! * span).toBeCloseTo(
      column.left + column.width,
    );
  });
});
