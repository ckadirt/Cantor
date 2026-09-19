import { PaintStyle } from '@shopify/react-native-skia';
import { availabilityOf } from './availability';
import { waveBar } from './cantorWaveGeometry';
import { LENS_INTERVALS } from './cantorIntervals';
import type { Lens } from './types';

/** KNOBS — bar geometry per level, in real pixels. */
const CANTOR_WAVE_KNOBS = {
  MARK_WIDTH_PX: 14, // the whole set, at L0
  MARK_HEIGHT_PX: 11,
  ROW_WIDTH_PX: 130, // at L1 there is room for the shape to be read
  ROW_HEIGHT_PX: 20,
  // The preview column, left of the text. The name lens puts its dot at 98 and
  // starts the title at 42, so the wave has to end before that or it draws
  // straight through the words.
  ROW_LEFT_PX: 186,
  ROW_TEXT_LEFT_PX: 42,
  MIN_BAR_PX: 0.6, // a silent interval is still a mark, not a gap
  // Music sits around 0.1-0.3 RMS, so drawing it raw uses a third of the row.
  // A fixed gain spends the height without normalising per song -- normalising
  // would make a quiet song look as loud as a loud one, which is a lie about
  // the only thing this lens is showing.
  LEVEL_GAIN: 2.6,
  BAR_GAP_RATIO: 0.18, // fraction of a bar's slot left as air
  HEARD_ALPHA: 1, // the part already played
  UNHEARD_ALPHA: 0.38, // the part still to come
  // Availability, in the one term this lens has: a song whose audio is not on
  // the phone is drawn lighter than one that is. The face's cached-versus-
  // downloaded distinction has no bar equivalent and is not drawn here --
  // see docs/interfacealpha/implementation_notes.md.
  NOT_HERE_ALPHA: 0.45,
  /** At L2 the set is the picture, so it takes most of the view. */
  SONG_WIDTH_RATIO: 0.82,
  SONG_HEIGHT_RATIO: 0.3,
  PLAYING_RING_RADIUS_PX: 9,
  PLAYING_RING_WIDTH_PX: 1.2,
} as const;

/**
 * The song as its own Cantor set: one bar per middle-thirds interval, each as
 * tall as that slice is loud.
 *
 * This is the second lens, and the reason the registry is worth having: it
 * draws from the same `LensSong` the name lens does, into the same canvas, with
 * no component and no canvas of its own.
 *
 * A song with no audio on the phone still draws — as an even skeleton. Cantor
 * does not fetch a song in order to decorate it, so at L0 most of a large field
 * is structure rather than measurement, and that is honest rather than a
 * placeholder.
 */
export const cantorWaveLens: Lens = {
  key: 'cantor-wave',
  label: 'Cantor wave',
  draw(canvas, box, song, options) {
    const { alpha, paints } = options;
    if (alpha <= 0) return;

    // At L2 the set spans the view: the same bars, given the room to be read
    // as the Cantor set they are rather than as a preview of one.
    const width =
      box.kind === 'mark'
        ? CANTOR_WAVE_KNOBS.MARK_WIDTH_PX
        : box.kind === 'song'
          ? box.width * CANTOR_WAVE_KNOBS.SONG_WIDTH_RATIO
          : CANTOR_WAVE_KNOBS.ROW_WIDTH_PX;
    const height =
      box.kind === 'mark'
        ? CANTOR_WAVE_KNOBS.MARK_HEIGHT_PX
        : box.kind === 'song'
          ? box.height * CANTOR_WAVE_KNOBS.SONG_HEIGHT_RATIO
          : CANTOR_WAVE_KNOBS.ROW_HEIGHT_PX;
    const left =
      box.kind === 'row'
        ? box.x - CANTOR_WAVE_KNOBS.ROW_LEFT_PX
        : box.x - width / 2;
    const centre = box.y;

    const levels = song.analysis.rms;
    const heardUntil = song.progress === null ? -1 : song.progress;
    const availability = availabilityOf(song.audioState);
    const here =
      availability === 'cached' || availability === 'downloaded'
        ? 1
        : CANTOR_WAVE_KNOBS.NOT_HERE_ALPHA;

    for (let index = 0; index < LENS_INTERVALS.length; index += 1) {
      const interval = LENS_INTERVALS[index];
      const level = levels[index] ?? 0;
      const bar = waveBar(index, level, width, height);
      // An interval counts as heard once playback has passed its start.
      const heard = heardUntil >= interval.start;
      paints.ink.setAlphaf(
        alpha *
          here *
          (heardUntil < 0
            ? CANTOR_WAVE_KNOBS.HEARD_ALPHA
            : heard
              ? CANTOR_WAVE_KNOBS.HEARD_ALPHA
              : CANTOR_WAVE_KNOBS.UNHEARD_ALPHA),
      );
      canvas.drawRect(
        {
          x: left + width / 2 + bar.x,
          y: centre + bar.y,
          width: bar.width,
          height: bar.height,
        },
        paints.ink,
      );
    }

    if (song.playing) {
      paints.ink.setAlphaf(alpha);
      paints.ink.setStyle(PaintStyle.Stroke);
      paints.ink.setStrokeWidth(CANTOR_WAVE_KNOBS.PLAYING_RING_WIDTH_PX);
      canvas.drawCircle(
        left + width / 2,
        centre,
        CANTOR_WAVE_KNOBS.PLAYING_RING_RADIUS_PX +
          (box.kind === 'mark' ? 0 : height / 2),
        paints.ink,
      );
      paints.ink.setStyle(PaintStyle.Fill);
    }

    if (box.kind === 'row') {
      paints.ink.setAlphaf(alpha);
      paints.muted.setAlphaf(alpha);
      canvas.drawText(
        truncate(song.title),
        box.x - CANTOR_WAVE_KNOBS.ROW_TEXT_LEFT_PX,
        centre - 1,
        paints.ink,
        options.fonts.display,
      );
      canvas.drawText(
        `${formatDuration(song.durationMs)} · ${song.model.toUpperCase()}`,
        box.x - CANTOR_WAVE_KNOBS.ROW_TEXT_LEFT_PX,
        centre + 13,
        paints.muted,
        options.fonts.mono,
      );
    }
  },
};

function truncate(title: string): string {
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
