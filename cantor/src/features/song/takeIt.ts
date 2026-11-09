import { formatBytes } from '../../lenses/availability';
import {
  blockOf,
  mp3BytesOf,
  OFFERED_FORMATS,
  type ExportError,
  type TakeItSong,
} from '../../export/service';
import type {
  ExportCopy,
  ExportDestination,
  ExportFormat,
} from '../../export/types';

/**
 * What the song sheet's Take it measure says, in every state
 * (internal/docs/plans/take-it-plan.md, "The song sheet"). Pure: the hook
 * holds the state, the sheet draws these words, and every word that changes
 * morphs into the next.
 */
export type TakeItAct = 'share' | 'save';

export type TakeItState = Readonly<{
  song: TakeItSong;
  format: ExportFormat;
  destination: ExportDestination;
  /** The song's saved copies that still exist. */
  copies: readonly ExportCopy[];
  acting: TakeItAct | null;
  /** The last act that failed, and why; cleared by the next act. */
  failure: Readonly<{ act: TakeItAct; code: ExportError['code'] }> | null;
}>;

export type TakeItWords = Readonly<{
  /** The format's name, `MP3`: the chosen word of the format choice. */
  format: string;
  /** Its weight, or why nothing can be taken. */
  formatNote: string;
  share: string;
  shareNote: string;
  /** Share can be pressed (it may be working). */
  shareReach: boolean;
  save: string;
  saveNote: string;
  saveReach: boolean;
}>;

export const FORMAT_LABEL: Readonly<Record<ExportFormat, string>> = {
  opus: 'Opus',
  mp3: 'MP3',
  wav: 'WAV',
};

/** What each format is for: its note, and its state in the open choice. */
export const FORMAT_NOTE: Readonly<Record<ExportFormat, string>> = {
  opus: 'THE ORIGINAL',
  mp3: 'PLAYS ANYWHERE',
  wav: 'THE MASTER',
};

/** The format in force: the one chosen, when this build makes it. */
export function formatInForce(chosen: ExportFormat): ExportFormat {
  return OFFERED_FORMATS.includes(chosen) ? chosen : OFFERED_FORMATS[0];
}

/** The Android folder a destination names, as a person reads it. */
export function destinationName(destination: ExportDestination): string {
  switch (destination.kind) {
    case 'download':
      return 'Download/Cantor';
    case 'tree':
      return destination.name;
    default:
      return 'Music/Cantor';
  }
}

/** The verb on Save: `Save to Music`. */
function saveVerb(destination: ExportDestination): string {
  switch (destination.kind) {
    case 'download':
      return 'Save to Download';
    case 'tree':
      return `Save to ${destination.name}`;
    default:
      return 'Save to Music';
  }
}

/** Where a copy actually is, read from where it was written. */
export function copyFolder(copy: ExportCopy): string {
  const where = `${copy.path ?? ''} ${copy.uri}`.toLowerCase();
  return where.includes('/download') ? 'Download/Cantor' : 'Music/Cantor';
}

export function takeItWords(state: TakeItState): TakeItWords {
  const { song, format, destination, copies, acting, failure } = state;
  const block = blockOf(song);
  const here = song.audioState === 'cached' || song.audioState === 'pinned';
  const fetch = formatBytes(song.delivery?.byte_length ?? 0).toUpperCase();
  // What the file will weigh: the delivery as it is, or an MP3 at 320 kbps.
  const size = formatBytes(
    format === 'mp3'
      ? mp3BytesOf(song.song.duration_ms)
      : song.delivery?.byte_length ?? 0,
  ).toUpperCase();
  const copy = copies.find(
    candidate =>
      candidate.format === format &&
      candidate.digest === song.delivery?.sha256,
  );

  const formatNote =
    block === 'away'
      ? `${song.nodeLabel.toUpperCase()} IS AWAY`
      : block === 'no-audio'
      ? 'NO AUDIO YET'
      : here
      ? `${size} · ${FORMAT_NOTE[format]}`
      : `${fetch} TO FETCH`;

  // The present tense of the work under way: fetching the song first, then
  // making the file (an MP3 is most of the wait).
  const making = !here
    ? 'Fetching'
    : format === 'mp3'
    ? 'Making MP3'
    : null;
  const share = acting === 'share' ? making ?? 'Copying' : 'Share';
  const shareNote =
    failure?.act === 'share' ? 'COULD NOT SHARE' : 'THE FILE, NOT A LINK';

  const save =
    acting === 'save'
      ? making ?? 'Saving'
      : copy !== undefined
      ? `In ${copyFolder(copy)}`
      : saveVerb(destination);
  const saveNote =
    failure?.act === 'save'
      ? failure.code === 'permission'
        ? 'NOT ALLOWED TO SAVE'
        : 'COULD NOT SAVE'
      : copy !== undefined
      ? `SAVED · ${format.toUpperCase()} · ${formatBytes(copy.bytes).toUpperCase()}`
      : `INTO ${destinationName(destination).toUpperCase()}`;

  return {
    format: FORMAT_LABEL[format],
    formatNote,
    share,
    shareNote,
    shareReach: block === null && (acting === null || acting === 'share'),
    save,
    saveNote,
    saveReach:
      block === null &&
      (acting === 'save' || (acting === null && copy === undefined)),
  };
}
