import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import type {
  DeviceLibraryState,
  FolderProgress,
} from '../../device/deviceLibrary';
import type { FolderSummary } from '../../device/folders';
import { haptic } from '../../haptics';
import { TransformText } from '../../motion';
import { font, touch, type, usePalette } from '../../theme/tokens';
import {
  Caret,
  Coda,
  Fermata,
  FOLIO_ACT_STYLE,
  FOLIO_KNOBS,
  FOLIO_META_STYLE,
  FOLIO_NOTE_STYLE,
  Measure,
  PanelPressable,
  PhoneSealMark,
  Rest,
  Row,
  Stave,
  Underway,
  useReach,
} from '../controls';
import { FolderCover, ReadingClef } from './PhoneMarks';
import {
  albumsWord,
  capitalised,
  countWord,
  filesRead,
  folderNote,
  hasBroughtIn,
  measuresOf,
  newFolders,
  phoneCounts,
  phonePage,
  sizeWord,
  songsWord,
  type PhonePageKind,
} from './phoneState';

/** KNOBS — the phone's page (docs/import/flow-plan.md, I7f and I7g). */
export const PHONE_SHEET_KNOBS = {
  /** A folder's cover in the summary's label column. */
  FOLDER_COVER_PX: 34,
  /** And on the read page, where folders are doors. */
  DOOR_COVER_PX: 26,
  /** A folder's name: the display face, smaller than a node's. */
  FOLDER_NAME_PX: 18,
  FOLDER_NAME_LINE_PX: 24,
  /** How long `Nothing new` stands before the act says `Look again` again. */
  NOTHING_NEW_MS: 2000,
  /** The coda's words morph on this clock. */
  ACT_MS: 520,
  ACT_SLOT_PX: 28,
} as const;

export type PhoneActions = Readonly<{
  requestPermission: () => Promise<unknown>;
  openSettings: () => Promise<void>;
  look: () => Promise<{ changed: boolean }>;
  refresh: () => Promise<{ changed: boolean }>;
  bringIn: (leftOut: ReadonlySet<string>) => Promise<unknown>;
  /** `See them`: close the blind (I7j takes the camera to them). */
  seeThem: () => void;
  report: (error: unknown) => void;
}>;

export type PhonePage = Readonly<{
  kind: PhonePageKind;
  clef: React.ReactNode;
  meta: React.ReactNode;
  body: React.ReactNode;
  /** The roster was left: forget a finished bring-in and a choice. */
  leave: () => void;
}>;

/**
 * The phone's page: the frames `f-ask` to `f-none` of `flow.html`, chosen by
 * `phonePage` from the device store. A hook rather than a component because
 * the head is the nodes blind's own (`EnginesSheet`), so this hands it a clef
 * and a meta line beside the stave and coda it draws.
 */
export function usePhonePage({
  active,
  device,
  actions,
  publicKey,
}: {
  /** The page is the one shown: it looks when it opens. */
  active: boolean;
  device: DeviceLibraryState;
  actions: PhoneActions;
  publicKey: string;
}): PhonePage {
  const pal = usePalette();
  const [broughtIn, setBroughtIn] = useState(false);
  const [choosing, setChoosing] = useState(false);
  /** Taps since the summary was drawn: a folder's ink, by path. */
  const [taps, setTaps] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [act, setAct] = useState<'idle' | 'asking' | 'looking' | 'nothing'>(
    'idle',
  );
  const kind = phonePage({ device, broughtIn, choosing });
  const counts = phoneCounts(device);
  const folders = device.folders ?? [];
  const reading = device.scan.phase === 'inspecting' ? device.scan : null;

  /**
   * The bring-in's last folder counts, so `DONE` stays after it ends. Kept in
   * a ref while rendering: an effect would schedule a second render after
   * every progress tick.
   */
  const lastFolders = useRef<ReadonlyMap<string, FolderProgress> | null>(null);
  if (reading !== null) lastFolders.current = reading.folders;

  // Opening the page looks, once the permission is there.
  const looked = useRef(false);
  const { look, report } = actions;
  useEffect(() => {
    if (!active) {
      looked.current = false;
      return;
    }
    if (looked.current || device.permission !== 'granted') return;
    if (device.status !== 'ready') return;
    looked.current = true;
    look().catch(report);
  }, [active, device.permission, device.status, look, report]);

  // A folder's ink: tapped, else where it starts.
  const isLeftOut = useCallback(
    (folder: FolderSummary) => !(taps.get(folder.path) ?? folder.keep),
    [taps],
  );
  const toggle = (folder: FolderSummary) => {
    haptic('tick');
    setTaps(current => {
      const next = new Map(current);
      next.set(folder.path, isLeftOut(folder));
      return next;
    });
  };
  // Only folders not already kept are brought in by this act.
  const coming = folders.filter(
    folder => folder.status !== 'kept' && !isLeftOut(folder),
  );
  const comingSongs = coming.reduce((sum, folder) => sum + folder.songs, 0);

  const leave = useCallback(() => {
    if (device.scan.phase === 'idle') setBroughtIn(false);
    setChoosing(false);
    setTaps(new Map());
  }, [device.scan.phase]);

  const bringIn = () => {
    const leftOut = new Set(
      folders.filter(isLeftOut).map(folder => folder.path),
    );
    setBroughtIn(true);
    setChoosing(false);
    lastFolders.current = null;
    actions.bringIn(leftOut).catch(actions.report);
  };
  const lookAgain = () => {
    setAct('looking');
    actions
      .refresh()
      .then(result => setAct(result.changed ? 'idle' : 'nothing'))
      .catch(error => {
        setAct('idle');
        actions.report(error);
      });
  };
  useEffect(() => {
    if (act !== 'nothing') return;
    const timer = setTimeout(
      () => setAct('idle'),
      PHONE_SHEET_KNOBS.NOTHING_NEW_MS,
    );
    return () => clearTimeout(timer);
  }, [act]);
  const ask = () => {
    setAct('asking');
    actions
      .requestPermission()
      .catch(actions.report)
      .finally(() => setAct('idle'));
  };

  // Faint when out of reach or empty; asking is still the phone, in ink.
  const faintSeal =
    kind === 'denied' || kind === 'none' || kind === 'unavailable';
  const finished = kind === 'bringing' && device.scan.phase === 'idle';
  // The album being read while reading; once read, the phone again.
  const clef =
    kind === 'bringing' && !finished ? (
      <ReadingClef
        mediaId={reading?.current?.mediaId ?? null}
        size={FOLIO_KNOBS.CLEF_PX}
      />
    ) : (
      <PhoneSealMark
        faint={faintSeal}
        publicKey={publicKey}
        size={FOLIO_KNOBS.CLEF_PX}
        spindle
      />
    );

  const files = filesRead(device);
  const songsAlbums = `${songsWord(counts.songs)} · ${albumsWord(
    counts.albums,
  )}`;
  const metaWords = (() => {
    switch (kind) {
      case 'ask':
        return device.permission === 'denied'
          ? counts.songs > 0
            ? 'NOT ALLOWED NOW'
            : 'NOT ALLOWED YET'
          : 'NOT READ YET';
      case 'denied':
        return counts.songs > 0 ? 'NOT ALLOWED NOW' : 'NOT ALLOWED YET';
      case 'unavailable':
        return 'UNAVAILABLE';
      case 'listing':
        return 'READING';
      case 'none':
        return 'NO MUSIC FOUND';
      case 'summary':
        return `${folders.length} FOLDER${
          folders.length === 1 ? '' : 'S'
        } · ${songsWord(
          folders.reduce((sum, folder) => sum + folder.songs, 0),
        )}`;
      case 'new': {
        const fresh = newFolders(folders).length;
        return `${songsWord(counts.songs)} · ${fresh} NEW FOLDER${
          fresh === 1 ? '' : 'S'
        }`;
      }
      case 'bringing':
        return finished || device.scan.phase === 'saving'
          ? songsAlbums
          : `READING ${files.done} OF ${files.total}`;
      case 'read':
        return songsAlbums;
    }
  })();
  const held =
    kind === 'denied' ||
    kind === 'unavailable' ||
    (kind === 'ask' && device.permission === 'denied');
  const meta = held ? <HeldLine words={metaWords} /> : metaWords;

  let body: React.ReactNode;
  switch (kind) {
    case 'ask':
      body = (
        <>
          <Stave>
            <Measure>
              <Row>
                <Sentence>
                  Cantor plays your music where it lies. Nothing is copied,
                  moved or sent anywhere.
                </Sentence>
              </Row>
            </Measure>
            <Rest />
            <Measure>
              <Row label="Looks in" note="THIS PHONE'S OWN STORAGE">
                <Fact>Music, Download and the rest</Fact>
              </Row>
              <Row label="Leaves out" note="VOICE NOTES START GREY">
                <Fact>Ringtones, alarms, anything under thirty seconds</Fact>
              </Row>
              <Row label="Never" note="TAGS EDIT HERE ONLY">
                <Fact>Writes to your files</Fact>
              </Row>
            </Measure>
          </Stave>
          <Coda>
            <PhoneAct
              label="Allow music"
              onPress={ask}
              working={act === 'asking'}
            />
            <Note>ANDROID WILL ASK</Note>
          </Coda>
        </>
      );
      break;
    case 'denied':
      body = (
        <>
          <Stave>
            <Measure>
              <Row>
                <Sentence>
                  Cantor can't see your music until Android lets it. Nothing
                  else changes: the nodes and their songs are all still here.
                </Sentence>
              </Row>
            </Measure>
            <Rest />
            <Measure>
              <Row label="Where" note="THE LAST SWITCH">
                <Fact>Apps, Cantor, Permissions, Music and audio</Fact>
              </Row>
            </Measure>
          </Stave>
          <Coda>
            <PhoneAct
              label="Open Android settings"
              onPress={() => {
                actions.openSettings().catch(actions.report);
              }}
            />
            <Note>COMES BACK HERE AFTER</Note>
          </Coda>
        </>
      );
      break;
    case 'unavailable':
      body = (
        <>
          <Stave>
            <Measure>
              <Row>
                <Sentence>
                  The phone's own library could not be opened. Songs from the
                  nodes are all still here.
                </Sentence>
              </Row>
            </Measure>
          </Stave>
          <Coda />
        </>
      );
      break;
    case 'listing':
      body = (
        <>
          <Stave>
            <Measure>{null}</Measure>
          </Stave>
          <Coda>
            <PhoneAct label="Reading" onPress={noop} working />
            <Note>NOTHING IS OPENED YET</Note>
          </Coda>
        </>
      );
      break;
    case 'none':
      body = (
        <>
          <Stave>
            <Measure>
              <Row>
                <Sentence>
                  There is no music on this phone that Cantor can see yet. Files
                  copied into Music or Download appear here by themselves.
                </Sentence>
              </Row>
            </Measure>
            <Rest />
            <Measure>
              <Row label="Looked in" note="THIS PHONE'S STORAGE">
                <Fact>Music, Download and the rest</Fact>
              </Row>
            </Measure>
          </Stave>
          <Coda>
            <LookAgain act={act} onPress={lookAgain} />
            <Note>AND ON EVERY OPEN</Note>
          </Coda>
        </>
      );
      break;
    case 'summary':
    case 'new': {
      const fresh = kind === 'new';
      const shown = fresh ? newFolders(folders) : folders;
      const label =
        comingSongs === 0
          ? 'Nothing to bring in'
          : hasBroughtIn(device)
          ? `Bring in ${comingSongs} more`
          : `Bring in ${songsWord(comingSongs).toLowerCase()}`;
      body = (
        <>
          <Stave>
            {measuresOf(shown).map((measure, index) => (
              <React.Fragment key={measure[0].path}>
                {index > 0 ? <Rest /> : null}
                <Measure>
                  {measure.map(folder => (
                    <FolderChoice
                      folder={folder}
                      key={folder.path}
                      leftOut={isLeftOut(folder)}
                      markNew={fresh}
                      // A kept folder is left out on its own page (I7h).
                      onPress={
                        folder.status === 'kept'
                          ? undefined
                          : () => toggle(folder)
                      }
                    />
                  ))}
                </Measure>
              </React.Fragment>
            ))}
            {fresh ? (
              <>
                <Rest />
                <Measure>
                  <SongsFact device={device} />
                  <Row label="Folders">
                    <PlainDoor
                      label={keptWords(folders)}
                      onPress={() => setChoosing(true)}
                    />
                  </Row>
                </Measure>
              </>
            ) : null}
          </Stave>
          <Coda>
            <PhoneAct
              disabled={comingSongs === 0}
              label={label}
              onPress={bringIn}
            />
            <Note>TAP A FOLDER TO LEAVE IT OUT</Note>
          </Coda>
        </>
      );
      break;
    }
    case 'bringing': {
      const progress = reading?.folders ?? lastFolders.current;
      const lines = folders.filter(folder => progress?.has(folder.path));
      const current = reading?.current ?? null;
      const failed = device.result?.failed ?? 0;
      const fraction =
        reading === null
          ? finished
            ? 1
            : null
          : reading.total === 0
          ? 0
          : reading.done / reading.total;
      body = (
        <>
          <Stave>
            {current !== null && !finished ? (
              <>
                <Measure>
                  <Row label="Now">
                    <Text
                      numberOfLines={1}
                      style={[styles.folderName, { color: pal.ink }]}
                    >
                      {current.title ?? 'Untitled'}
                    </Text>
                    {current.artist === null ? null : (
                      <Text
                        numberOfLines={1}
                        style={[FOLIO_NOTE_STYLE, { color: pal.muted }]}
                      >
                        {current.artist.toUpperCase()}
                      </Text>
                    )}
                  </Row>
                </Measure>
                <Rest />
              </>
            ) : null}
            <Measure>
              {lines.map(folder => {
                const count = progress?.get(folder.path);
                const now =
                  count !== undefined &&
                  count.done > 0 &&
                  count.done < count.total;
                const done =
                  finished ||
                  (count !== undefined && count.done >= count.total);
                return (
                  <Row key={folder.path}>
                    <FolderName folder={folder} />
                    <Text
                      style={[
                        FOLIO_NOTE_STYLE,
                        { color: now ? pal.ink : pal.faint },
                      ]}
                    >
                      {done
                        ? 'DONE'
                        : now
                        ? `${count.done} OF ${count.total}`
                        : 'WAITING'}
                    </Text>
                  </Row>
                );
              })}
            </Measure>
            {finished && failed > 0 ? (
              <>
                <Rest />
                <Measure>
                  <Row label="Couldn't read" note="LEFT ALONE">
                    <Fact>
                      {failed} file{failed === 1 ? '' : 's'}
                    </Fact>
                  </Row>
                </Measure>
              </>
            ) : null}
          </Stave>
          <Coda>
            <PhoneAct
              fraction={fraction}
              label={finished ? 'See them' : 'Bringing them in'}
              onPress={
                finished
                  ? () => {
                      setBroughtIn(false);
                      actions.seeThem();
                    }
                  : noop
              }
              working={!finished}
            />
            <Note>{finished ? songsAlbums : 'YOU CAN CLOSE THIS'}</Note>
          </Coda>
        </>
      );
      break;
    }
    case 'read': {
      const kept = folders.filter(folder => folder.status === 'kept');
      const out = folders.filter(folder => folder.status === 'excluded');
      const failed = device.result?.failed ?? 0;
      body = (
        <>
          <Stave>
            <Measure>
              <SongsFact device={device} />
            </Measure>
            <Rest />
            <Measure>
              {kept.map(folder => (
                <Row
                  key={folder.path}
                  mark={
                    <FolderCover
                      mediaId={folder.coverMediaId}
                      size={PHONE_SHEET_KNOBS.DOOR_COVER_PX}
                    />
                  }
                >
                  <FolderName folder={folder} />
                  <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
                    {folderNote(folder, false)}
                  </Text>
                </Row>
              ))}
              {out.length > 0 ? (
                <Row
                  mark={
                    <FolderCover
                      faint
                      mediaId={null}
                      size={PHONE_SHEET_KNOBS.DOOR_COVER_PX}
                    />
                  }
                >
                  <PlainDoor
                    faint
                    label={`${capitalised(countWord(out.length))} left out`}
                    onPress={() => setChoosing(true)}
                  />
                  <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
                    {leftOutNote(out)}
                  </Text>
                </Row>
              ) : null}
            </Measure>
            {counts.missing > 0 || failed > 0 ? (
              <>
                <Rest />
                <Measure>
                  {counts.missing > 0 ? (
                    <Row label="Missing">
                      <Fact>
                        {counts.missing} song{counts.missing === 1 ? '' : 's'}
                      </Fact>
                      <HeldNote words="FILE MOVED OR REMOVED" />
                    </Row>
                  ) : null}
                  {failed > 0 ? (
                    <Row label="Couldn't read" note="LEFT ALONE">
                      <Fact>
                        {failed} file{failed === 1 ? '' : 's'}
                      </Fact>
                    </Row>
                  ) : null}
                </Measure>
              </>
            ) : null}
          </Stave>
          <Coda>
            <LookAgain act={act} onPress={lookAgain} />
            <Note>
              {device.lookedAtMs === null
                ? 'AND ON EVERY OPEN'
                : `LOOKED AT ${clock(device.lookedAtMs)}`}
            </Note>
          </Coda>
        </>
      );
      break;
    }
  }

  return { kind, clef, meta, body, leave };
}

/** A folder on the summary: a tap swaps its ink and the coda's count morphs. */
function FolderChoice({
  folder,
  leftOut,
  markNew,
  onPress,
}: {
  folder: FolderSummary;
  leftOut: boolean;
  markNew: boolean;
  onPress?: () => void;
}) {
  const pal = usePalette();
  const note = folderNote(folder, leftOut, markNew);
  const content = (
    <View>
      <FolderName folder={folder} leftOut={leftOut} />
      <Text
        style={[
          FOLIO_NOTE_STYLE,
          {
            color:
              markNew && !leftOut && folder.status === 'new'
                ? pal.ink
                : pal.faint,
          },
        ]}
      >
        {note}
      </Text>
    </View>
  );
  return (
    <Row
      mark={
        <FolderCover
          faint={leftOut}
          mediaId={folder.coverMediaId}
          size={PHONE_SHEET_KNOBS.FOLDER_COVER_PX}
        />
      }
    >
      {onPress === undefined ? (
        content
      ) : (
        <PanelPressable
          accessibilityLabel={`${folder.name}, ${
            leftOut ? 'left out' : 'brought in'
          }`}
          accessibilityRole="switch"
          accessibilityState={{ checked: !leftOut }}
          onPress={onPress}
          style={styles.choice}
        >
          {content}
        </PanelPressable>
      )}
    </Row>
  );
}

/** `Music / Bandcamp`, the root faint; elsewhere the folder's own name. */
function FolderName({
  folder,
  leftOut = false,
}: {
  folder: FolderSummary;
  leftOut?: boolean;
}) {
  const pal = usePalette();
  const { tint } = useReach(leftOut, { from: pal.ink });
  const inner = folder.root !== null && !folder.loose;
  return (
    <Animated.Text numberOfLines={1} style={[styles.folderName, tint]}>
      {inner ? (
        <Text style={{ color: pal.faint }}>{`${folder.root} / `}</Text>
      ) : null}
      {inner ? folder.label.slice(folder.root!.length + 1) : folder.name}
    </Animated.Text>
  );
}

function SongsFact({ device }: { device: DeviceLibraryState }) {
  const counts = phoneCounts(device);
  return (
    <Row
      label="Songs"
      note={`${counts.artists} ARTIST${
        counts.artists === 1 ? '' : 'S'
      } · ${sizeWord(counts.bytes)}`}
    >
      <Fact>{String(counts.songs)}</Fact>
    </Row>
  );
}

/** The coda's act: morphs its words, greys when out of reach, waves while working. */
function PhoneAct({
  disabled = false,
  fraction = null,
  label,
  onPress,
  working = false,
}: {
  disabled?: boolean;
  fraction?: number | null;
  label: string;
  onPress: () => void;
  working?: boolean;
}) {
  const { colour } = useReach(disabled);
  return (
    <PanelPressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: working }}
      disabled={disabled}
      onPress={working ? undefined : onPress}
      style={styles.act}
    >
      <View>
        <TransformText
          charStyle={FOLIO_ACT_STYLE}
          color={colour}
          duration={PHONE_SHEET_KNOBS.ACT_MS}
          style={styles.actSlot}
          text={label}
        />
        <Underway
          charStyle={FOLIO_ACT_STYLE}
          fraction={fraction}
          label={label}
          working={working}
        />
      </View>
    </PanelPressable>
  );
}

function LookAgain({
  act,
  onPress,
}: {
  act: 'idle' | 'asking' | 'looking' | 'nothing';
  onPress: () => void;
}) {
  return (
    <PhoneAct
      label={
        act === 'looking'
          ? 'Looking'
          : act === 'nothing'
          ? 'Nothing new'
          : 'Look again'
      }
      onPress={onPress}
      working={act === 'looking'}
    />
  );
}

/** A door in Spectral, no name face: `Four kept, three left out`. */
function PlainDoor({
  faint = false,
  label,
  onPress,
}: {
  faint?: boolean;
  label: string;
  onPress: () => void;
}) {
  const pal = usePalette();
  const colour = faint ? pal.faint : pal.ink;
  return (
    <PanelPressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.door}
    >
      <Text numberOfLines={1} style={[styles.folderName, { color: colour }]}>
        {label}
      </Text>
      <Caret colour={colour} direction="right" />
    </PanelPressable>
  );
}

function HeldLine({ words }: { words: string }) {
  const pal = usePalette();
  return (
    <View accessible accessibilityLabel={words} style={styles.held}>
      <Fermata colour={pal.ink} />
      <Text style={[FOLIO_META_STYLE, { color: pal.faint }]}>{words}</Text>
    </View>
  );
}

function HeldNote({ words }: { words: string }) {
  const pal = usePalette();
  return (
    <View accessible accessibilityLabel={words} style={styles.held}>
      <Fermata colour={pal.faint} />
      <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>{words}</Text>
    </View>
  );
}

function Sentence({ children }: { children: React.ReactNode }) {
  const pal = usePalette();
  return <Text style={[type.body, { color: pal.ink }]}>{children}</Text>;
}

function Fact({ children }: { children: React.ReactNode }) {
  const pal = usePalette();
  return <Text style={[type.body, { color: pal.ink }]}>{children}</Text>;
}

function Note({ children }: { children: React.ReactNode }) {
  const pal = usePalette();
  return (
    <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>{children}</Text>
  );
}

function keptWords(folders: readonly FolderSummary[]): string {
  const kept = folders.filter(folder => folder.status === 'kept').length;
  const out = folders.filter(folder => folder.status === 'excluded').length;
  const words = `${capitalised(countWord(kept))} kept`;
  return out === 0 ? words : `${words}, ${countWord(out)} left out`;
}

function leftOutNote(out: readonly FolderSummary[]): string {
  const files = out.reduce((sum, folder) => sum + folder.songs, 0);
  const voices = out.every(folder => folder.voiceNotes);
  return `${voices ? 'VOICE NOTES · ' : ''}${files} FILE${
    files === 1 ? '' : 'S'
  }`;
}

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function noop() {}

const styles = StyleSheet.create({
  folderName: {
    fontFamily: font.display,
    fontSize: PHONE_SHEET_KNOBS.FOLDER_NAME_PX,
    lineHeight: PHONE_SHEET_KNOBS.FOLDER_NAME_LINE_PX,
  },
  choice: { alignSelf: 'stretch' },
  door: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: touch.min / 2,
  },
  held: { alignItems: 'center', flexDirection: 'row' },
  act: { justifyContent: 'center', minHeight: touch.min },
  actSlot: { height: PHONE_SHEET_KNOBS.ACT_SLOT_PX },
});
