// Code blocks in the app's ink: no hue, comments in the muted grey.
import { defineEcConfig, ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';

const theme = (type, paper, ink, muted, line) =>
  new ExpressiveCodeTheme({
    name: `cantor-${type}`,
    type,
    colors: {
      'editor.background': paper,
      'editor.foreground': ink,
      'editor.selectionBackground': line,
      'editorGroupHeader.tabsBackground': paper,
      'tab.activeBackground': paper,
      'tab.activeForeground': ink,
      'tab.border': line,
    },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: muted } },
      { scope: ['string', 'constant', 'keyword', 'variable', 'entity', 'support', 'storage'], settings: { foreground: ink } },
      { scope: ['punctuation', 'meta.brace'], settings: { foreground: muted } },
    ],
  });

export default defineEcConfig({
  themes: [theme('dark', '#000000', '#ffffff', '#8c8c8c', '#2a2a2a'), theme('light', '#ffffff', '#000000', '#737373', '#e6e6e6')],
  styleOverrides: {
    borderRadius: '0',
    borderColor: 'var(--line)',
    codeFontFamily: 'var(--mono)',
    codeFontSize: '0.875rem',
    codeLineHeight: '1.65',
    uiFontFamily: 'var(--mono)',
    frames: {
      shadowColor: 'transparent',
      editorActiveTabIndicatorTopColor: 'transparent',
      editorActiveTabIndicatorBottomColor: 'var(--ink)',
      terminalTitlebarBackground: 'var(--paper)',
      terminalTitlebarBorderBottomColor: 'var(--line)',
      terminalBackground: 'var(--paper)',
      terminalTitlebarDotsOpacity: '0',
      inlineButtonBorder: 'var(--line)',
      tooltipSuccessBackground: 'var(--ink)',
      tooltipSuccessForeground: 'var(--paper)',
    },
  },
});
