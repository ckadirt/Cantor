import type { SkCanvas, SkFont, SkPaint } from '@shopify/react-native-skia';
import type { SongAnalysis } from './analysis';

export type LensBox = Readonly<{
  kind: 'mark' | 'row';
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Renderer-ready facts about a song. Runtime objects are never imported here. */
export type LensSong = Readonly<{
  key: string;
  /** The song's own id, so a face survives a node that reports no seed. */
  id: string;
  title: string;
  createdAtMs: number;
  durationMs: number;
  model: string;
  /**
   * `SongHeader.seed` when the node sent one. With the model and the duration
   * this is the whole recipe, which is what a lens draws the song's face from —
   * see `face.ts` and `docs/interface/alpha-design.md`.
   */
  seed: number | undefined;
  nodeLabel: string;
  audioState: 'remote' | 'partial' | 'cached' | 'pinned';
  /**
   * How much of the delivery artifact has landed, 0..1, or null when nothing is
   * arriving or the total byte length is unknown.
   *
   * Only meaningful while `audioState` is `partial`; see `availability.ts`,
   * which turns both facts into the four marks the field draws.
   */
  arriving: number | null;
  /**
   * The delivery artifact's size in bytes, or null when the node has not
   * offered one yet. What a downloaded row weighs, and what a shelf sums.
   */
  byteLength: number | null;
  /** True for the song the player currently holds, at every level it appears. */
  playing: boolean;
  /**
   * One RMS and one peak per Cantor interval, already reduced to 0..1.
   *
   * Never null: a song with no local audio carries the neutral skeleton, so a
   * lens never has to decide whether to download something in order to draw.
   */
  analysis: SongAnalysis;
  /**
   * How far through this song playback is, 0..1, or null when it is not the
   * playing song. Lets a lens distinguish the part already heard.
   */
  progress: number | null;
}>;

export type LensFonts = Readonly<{
  display: SkFont;
  body: SkFont;
  mono: SkFont;
}>;

/** Paints are prepared once by FieldCanvas and reused for every draw call. */
export type LensPaints = Readonly<{
  ink: SkPaint;
  muted: SkPaint;
  faint: SkPaint;
  /**
   * Ink, stroked at a hairline. A face is an outline, and creating a stroke
   * paint per mark would allocate once per song per frame at L0.
   */
  outline: SkPaint;
}>;

export type LensOptions = Readonly<{
  alpha: number;
  fonts: LensFonts;
  paints: LensPaints;
}>;

/** A lens draws into the shared field picture; it never owns a canvas. */
export type Lens = Readonly<{
  key: string;
  label: string;
  draw: (
    canvas: SkCanvas,
    box: LensBox,
    song: LensSong,
    options: LensOptions,
  ) => void;
}>;
