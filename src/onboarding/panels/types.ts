/** Contracts between Onboarding's morphing frame and the content panels. */
import type * as React from 'react';
import type { Shape } from '../../motion';

export type PhraseHandoffWord = {
  key: string;
  text: string;
  /** Window coordinates, converted to the onboarding frame by its owner. */
  x: number;
  y: number;
  width: number;
};

export type PhraseHandoffLayout = {
  words: readonly PhraseHandoffWord[];
};

export type PanelTransitionRequest = {
  kind: 'identity-to-backup';
  source: PhraseHandoffLayout;
};

/** What a panel body receives from the persistent onboarding frame. */
export type PanelBodyProps = {
  onNext: (transition?: PanelTransitionRequest) => void;
  onDone: () => void;
  phraseHandoffActive?: boolean;
  onPhraseTarget?: (target: PhraseHandoffLayout) => void;
};

/**
 * A content panel as data. The frame owns (and morphs) the sigil, eyebrow, and
 * title from step to step; Body is only what scrolls beneath them, plus the
 * footer it controls.
 */
export type PanelDef = {
  key: string;
  eyebrow: string;
  title: string;
  sigil: Shape;
  Body: React.ComponentType<PanelBodyProps>;
};
