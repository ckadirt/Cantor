import type { SkCanvas, SkFont, SkPaint } from '@shopify/react-native-skia';

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
  title: string;
  createdAtMs: number;
  durationMs: number;
  model: string;
  nodeLabel: string;
  audioState: 'remote' | 'partial' | 'cached' | 'pinned';
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
