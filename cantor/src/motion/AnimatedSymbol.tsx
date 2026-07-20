/**
 * Semantic entrypoint for the canonical symbol set.
 *
 * Change `symbol` to morph, change `centerX` / `centerY` to relocate, pass an
 * external `progress` to scrub, or use `appearance="write"` for a first-mount
 * trace. Aspect ratio and stroke width remain optically tunable per instance.
 */
import React from 'react';
import { MorphShape, type MorphShapeProps } from './MorphShape';
import { SYMBOL_LIBRARY, type SymbolName } from './symbolLibrary';

export type AnimatedSymbolProps = Omit<MorphShapeProps, 'shape'> & {
  symbol: SymbolName;
};

export const AnimatedSymbol = React.memo(function AnimatedSymbolComponent({
  symbol,
  ...props
}: AnimatedSymbolProps) {
  return <MorphShape shape={SYMBOL_LIBRARY[symbol]} {...props} />;
});

export type WriteSymbolProps = Omit<AnimatedSymbolProps, 'appearance'>;

export const WriteSymbol = React.memo(function WriteSymbolComponent(
  props: WriteSymbolProps,
) {
  return <AnimatedSymbol {...props} appearance="write" />;
});
