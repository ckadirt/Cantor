/** Exact, source-derived rendering for a symbol primitive's settled state. */
import React from 'react';
import { Canvas, Path } from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';
import { compoundPolygonPath } from './geometry';
import { resolveSilhouette } from './silhouette';
import { SYMBOL_LIBRARY, type SymbolName } from './symbolLibrary';

type ArtworkOpacity = number | SharedValue<number>;

export type SymbolArtworkPathProps = {
  symbol: SymbolName;
  centerX: number;
  centerY: number;
  /** Authored height in canvas pixels. */
  size: number;
  color: string;
  opacity?: ArtworkOpacity;
  aspectRatio?: number;
  /** Canonical outline weight in authoring units. */
  strokeWidth?: number;
};

/**
 * A canonical compound glyph path for composition inside an existing Canvas.
 * Use this for the crisp final state; use AnimatedSymbol for travelling,
 * writing, and morphing between the primitive's independent contours.
 */
export function SymbolArtworkPath({
  symbol,
  centerX,
  centerY,
  size,
  color,
  opacity = 1,
  aspectRatio,
  strokeWidth,
}: SymbolArtworkPathProps) {
  const primitive = SYMBOL_LIBRARY[symbol];
  // The compound SVG already owns its width/height relationship. Only an
  // explicit caller override may opt into non-uniform scaling.
  const ratio = aspectRatio ?? 1;
  const silhouette = resolveSilhouette(primitive, size * ratio, size, 1, {
    centerX,
    centerY,
    aspectRatio: ratio,
    strokeWidth,
  });
  const path = compoundPolygonPath(silhouette.contours);

  return (
    <Path
      path={path}
      style="fill"
      fillType="evenOdd"
      color={color}
      opacity={opacity}
    />
  );
}

export type CanonicalSymbolProps = {
  symbol: SymbolName;
  width: number;
  height: number;
  color: string;
  /** Fraction of the available axes occupied by the symbol. */
  scale?: number;
  centerX?: number;
  centerY?: number;
  opacity?: number;
  aspectRatio?: number;
  strokeWidth?: number;
};

/** Standalone Canvas wrapper for the exact reusable silhouette. */
export const CanonicalSymbol = React.memo(function CanonicalSymbolComponent({
  symbol,
  width,
  height,
  color,
  scale = 0.82,
  centerX = width / 2,
  centerY = height / 2,
  opacity = 1,
  aspectRatio,
  strokeWidth,
}: CanonicalSymbolProps) {
  const ratio = aspectRatio ?? 1;
  const size = Math.min(height * scale, (width * scale) / ratio);
  return (
    <Canvas style={{ width, height }}>
      <SymbolArtworkPath
        symbol={symbol}
        centerX={centerX}
        centerY={centerY}
        size={size}
        color={color}
        opacity={opacity}
        aspectRatio={ratio}
        strokeWidth={strokeWidth}
      />
    </Canvas>
  );
});
