import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/useStore';
import {
  chooseExportPreferences,
  exportPreferences,
} from '../../export/preferences';
import {
  ExportError,
  OFFERED_FORMATS,
  type ExportService,
  type TakeItSong,
} from '../../export/service';
import type { ExportCopy, ExportFormat } from '../../export/types';
import {
  copyFolder,
  formatChoices,
  formatInForce,
  takeItWords,
  type TakeItAct,
  type TakeItState,
  type TakeItWords,
} from './takeIt';

/** What the sheet draws and calls; null for a song that cannot be taken. */
export type TakeItModel = Readonly<{
  words: TakeItWords;
  acting: TakeItAct | null;
  /** The format in force, and the formats offered, in order. */
  format: ExportFormat;
  formats: readonly ExportFormat[];
  /** Each format as the choice lists it: out of reach (faint) with its reason. */
  choices: ReturnType<typeof formatChoices>;
  /** How much of a fetched file has arrived, 0..1, while one is; else null. */
  progress: number | null;
  /** Choose another format: remembered for every song on this phone. */
  onFormat: (format: ExportFormat) => void;
  /**
   * Where the song's saved copies are, `Music/Cantor · OPUS`: the back page
   * says so beside Delete, because deleting the song leaves them.
   */
  copies: readonly string[];
  onShare: () => void;
  onSave: () => void;
}>;

/**
 * The Take it measure's state for one song: the format and folder in force,
 * the copies that still exist (asked again whenever the sheet opens on it),
 * and the act running. `song` is null for an imported song or a closed sheet.
 */
export function useTakeIt(
  song: TakeItSong | null,
  service: ExportService | null,
  visible: boolean,
): TakeItModel | null {
  const preferences = useStore(exportPreferences, state => state);
  const [copies, setCopies] = useState<readonly ExportCopy[]>([]);
  const [acting, setActing] = useState<TakeItAct | null>(null);
  const [failure, setFailure] = useState<TakeItState['failure']>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const latest = useRef(song);
  latest.current = song;
  const nodeKey = song?.nodeKey ?? null;
  const songId = song?.song.id ?? null;

  const refresh = useCallback(async () => {
    if (service === null || nodeKey === null || songId === null) return;
    try {
      const found = await service.copies(nodeKey, songId);
      // Only for the song still shown.
      if (latest.current?.song.id === songId) setCopies(found);
    } catch {
      // The copies stand as last known; nothing to take back.
    }
  }, [nodeKey, service, songId]);

  // Another song is another song's copies and another song's failure.
  useEffect(() => {
    setCopies([]);
    setFailure(null);
  }, [nodeKey, songId]);
  useEffect(() => {
    if (visible) refresh().catch(() => {});
  }, [refresh, visible]);

  const format = formatInForce(preferences.format);
  const run = useCallback(
    (act: TakeItAct) => {
      const current = latest.current;
      if (service === null || current === null || acting !== null) return;
      setActing(act);
      setFailure(null);
      // A file that is fetched while you wait (the master) says how far it is.
      const onProgress = (fraction: number) => setProgress(fraction);
      const work =
        act === 'share'
          ? service.share(current, format, onProgress)
          : service.save(current, format, preferences.destination, onProgress);
      work
        .then(() => (act === 'save' ? refresh() : undefined))
        .catch(error => {
          setFailure({
            act,
            code: error instanceof ExportError ? error.code : 'failed',
          });
        })
        .finally(() => {
          setActing(null);
          setProgress(null);
        });
    },
    [acting, format, preferences.destination, refresh, service],
  );
  const onFormat = useCallback(
    (next: ExportFormat) => {
      // A format out of reach is listed, faint, and is not picked.
      const current = latest.current;
      if (
        current !== null &&
        formatChoices(current).some(choice => choice.format === next && choice.quiet)
      ) {
        return;
      }
      chooseExportPreferences({ ...preferences, format: next }).catch(() => {});
      setFailure(null);
    },
    [preferences],
  );
  const onShare = useCallback(() => run('share'), [run]);
  const onSave = useCallback(() => run('save'), [run]);

  return useMemo(() => {
    if (song === null || service === null) return null;
    return {
      words: takeItWords({
        song,
        format,
        destination: preferences.destination,
        copies,
        acting,
        failure,
      }),
      acting,
      format,
      formats: OFFERED_FORMATS,
      choices: formatChoices(song),
      progress,
      onFormat,
      copies: copies.map(
        copy => `${copyFolder(copy)} · ${copy.format.toUpperCase()}`,
      ),
      onShare,
      onSave,
    };
  }, [
    acting,
    copies,
    failure,
    format,
    onFormat,
    onSave,
    onShare,
    preferences.destination,
    progress,
    service,
    song,
  ]);
}
