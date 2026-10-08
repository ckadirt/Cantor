import { heldLabelText } from '../nativeLabels';
import { LABEL_MORPH_KNOBS } from '../labelMorph';

describe('the name an interrupted re-cut resumes from', () => {
  const { FIELD_CROSSFADE_START, FIELD_CROSSFADE_END } = LABEL_MORPH_KNOBS;
  const half = (FIELD_CROSSFADE_START + FIELD_CROSSFADE_END) / 2;

  it('is the line leaving until the crossfade is half done', () => {
    expect(heldLabelText('LAST WEEK', 'OCTOBER', 0)).toBe('LAST WEEK');
    expect(heldLabelText('LAST WEEK', 'OCTOBER', FIELD_CROSSFADE_START)).toBe(
      'LAST WEEK',
    );
    expect(heldLabelText('LAST WEEK', 'OCTOBER', half - 0.01)).toBe(
      'LAST WEEK',
    );
  });

  it('is the line arriving after it', () => {
    expect(heldLabelText('LAST WEEK', 'OCTOBER', half + 0.01)).toBe('OCTOBER');
    expect(heldLabelText('LAST WEEK', 'OCTOBER', 1)).toBe('OCTOBER');
  });

  it('fades a line that has nothing to cross with on its own window', () => {
    const fadeHalf = LABEL_MORPH_KNOBS.FADE_END / 2;
    expect(heldLabelText('', '157 SONGS', fadeHalf - 0.01)).toBe('');
    expect(heldLabelText('', '157 SONGS', fadeHalf + 0.01)).toBe('157 SONGS');
  });
});
