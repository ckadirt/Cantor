/** Contracts between Onboarding's morphing frame and the content panels. */
import type * as React from 'react';
import type { Sigil } from '../sigils';

/** What a panel body receives: just its exits. */
export type PanelBodyProps = {
  onNext: () => void;
  onDone: () => void;
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
  sigil: Sigil;
  Body: React.ComponentType<PanelBodyProps>;
};
