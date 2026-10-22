/**
 * The identity reveal's geometry, built once at build time: each word of a
 * phrase as the 11 bits it encodes (its index in the BIP39 list, as the app's
 * `wordBits` reads it), then as the word, both as glyph outlines in the site's
 * display face, paired for the morph by `morph.ts`.
 */
import { readFileSync } from 'node:fs';
import { create, type Font } from 'fontkitten';
import { contoursOf, flattenCommands, morph, type Morph, type Pt } from './morph';

export type PhraseSlot = Morph & {
  word: string;
  bits: string;
  /** Which glyph each `from` contour belongs to, for the write's per-glyph lag. */
  fromGlyph: number[];
  glyphs: number;
  /** Advance widths, in ems. */
  bitsWidth: number;
  wordWidth: number;
};

/** A line of text as rings in ems with y down, and which glyph each came from. */
function outline(font: Font, text: string) {
  const scale = 1 / font.unitsPerEm;
  const rings: Pt[][] = [];
  const glyph: number[] = [];
  let x = 0;
  [...text].forEach((ch, g) => {
    const shape = font.glyphForCodePoint(ch.codePointAt(0)!);
    for (const ring of flattenCommands(shape.path.commands)) {
      rings.push(ring.map((p) => ({ x: x + p.x * scale, y: -p.y * scale })));
      glyph.push(g);
    }
    x += shape.advanceWidth * scale;
  });
  return { contours: contoursOf(rings), glyph, width: x };
}

export function phraseGeometry(fontFile: string, words: { word: string; bits: string }[]): PhraseSlot[] {
  const font = create(readFileSync(fontFile)) as Font;
  return words.map(({ word, bits }) => {
    const a = outline(font, bits);
    const b = outline(font, word);
    return {
      ...morph(a.contours, b.contours),
      word,
      bits,
      fromGlyph: a.glyph,
      glyphs: bits.length,
      bitsWidth: +a.width.toFixed(4),
      wordWidth: +b.width.toFixed(4),
    };
  });
}
