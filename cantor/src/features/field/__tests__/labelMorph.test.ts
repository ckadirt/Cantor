import { Skia } from '@shopify/react-native-skia';
import { drawLabelMorph, planLabelMorph, planShelfLabels } from '../labelMorph';

const NOW = new Date(2026, 7, 30, 12).getTime();
const font = Skia.Font(undefined, 9);
const groups = (...labels: string[]) =>
  labels.map(label => ({ key: label, label }));

describe('shelf label morphs', () => {
  it('plans nothing when the label did not change', () => {
    expect(planLabelMorph('AUGUST', 'AUGUST', font)).toBeNull();
    expect(
      planShelfLabels(groups('2026-08'), groups('2026-08'), font, NOW),
    ).toBeNull();
  });

  it('fades a line that has nothing to correspond with', () => {
    const entering = planLabelMorph('', 'AUGUST', font);
    expect(entering).toMatchObject({ kind: 'enter', to: 'AUGUST' });
    const leaving = planLabelMorph('AUGUST', '', font);
    expect(leaving).toMatchObject({ kind: 'exit', from: 'AUGUST' });
    // A year has no key beneath it, so that line leaves rather than morphing.
    expect(planLabelMorph('2026-08', '', font)?.kind).toBe('exit');
  });

  it('pairs clusters by index, so a re-cut keeps chronological order', () => {
    // Three weeks become one month: only the surviving cluster can be keyed,
    // and the surplus weeks leave with their marks rather than being paired.
    const shrunk = planShelfLabels(
      groups('2026-W33', '2026-W34', '2026-W35'),
      groups('2026-08'),
      font,
      NOW,
    );
    for (const key of shrunk?.keys() ?? []) expect(key).toBe('2026-08');

    // One month becomes three weeks: index 0 pairs with the month, and the two
    // beyond the old list's end have no predecessor at all.
    const grown = planShelfLabels(
      groups('2026-08'),
      groups('2026-W33', '2026-W34', '2026-W35'),
      font,
      NOW,
    );
    expect(grown?.get('2026-W34')?.primary?.kind).toBe('enter');
    expect(grown?.get('2026-W35')?.primary?.kind).toBe('enter');
    // The paired one is a morph, or absent where the runtime cannot build it.
    expect(grown?.get('2026-W33')?.primary?.kind ?? 'morph').toBe('morph');
  });

  it('never plans against an empty history, so first paint does not animate', () => {
    expect(planShelfLabels([], groups('2026-08'), font, NOW)).toBeNull();
  });

  /**
   * `Skia.Path.MakeFromText` does not exist under CanvasKit, which is what jest
   * runs. The contract is that the plan degrades to null and the caller draws
   * the settled text — never a half-built morph.
   */
  it('degrades to no plan when the runtime has no glyph outlines', () => {
    const plan = planLabelMorph('THIS WEEK', 'AUGUST', font);
    expect(plan === null || plan.kind === 'morph').toBe(true);
  });

  it('draws an entering line without throwing, at both ends of the clock', () => {
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 200, 100));
    const paint = Skia.Paint();
    const entering = planLabelMorph('', 'AUGUST', font);
    expect(entering).not.toBeNull();
    for (const t of [0, 0.5, 1]) {
      expect(() =>
        drawLabelMorph(canvas, entering!, 100, 50, t, paint, 1, font),
      ).not.toThrow();
    }
    expect(recorder.finishRecordingAsPicture()).toBeTruthy();
  });
});
