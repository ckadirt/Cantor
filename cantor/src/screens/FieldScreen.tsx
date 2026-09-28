import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  BackHandler,
  PixelRatio,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PairBackendModal } from '../backends/PairBackendModal';
import { openPhoneDatabase } from '../device/database';
import { DeviceLibraryService } from '../device/deviceLibrary';
import { nativeMedia } from '../device/native';
import { createDeviceRepository } from '../device/repository';
import { EnginesSheet } from '../features/engines';
import {
  audioRefOf,
  FieldA11yList,
  FieldCanvas,
  FieldOverlay,
  OriginMark,
  useFieldCamera,
} from '../features/field';
import {
  createFieldControllerStore,
  type FieldControllerStore,
} from '../features/field/fieldControllerStore';
import { ComposerSheet, type ComposerTarget } from '../features/composer';
import { Curtain } from '../features/curtain';
import { CondenseOverlay } from '../features/composer/CondenseOverlay';
import {
  Easing,
  cancelAnimation,
  useAnimatedReaction,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { playerRadiusPx } from '../features/field/songPose';
import {
  grainBarsOf,
  type GrainBars,
  type GrainRender,
} from '../features/field/FieldCanvas';
import type {
  FieldController,
  FieldPresentation,
} from '../features/field/useFieldController';
import { useShelfQueue } from '../features/field/useShelfQueue';
import { easeSmoother } from '../motion';
import { LensPicker } from '../features/song/LensPicker';
import {
  SongSheet,
  SONG_SHEET_KNOBS,
  type ImportedFacts,
  type SongAct,
} from '../features/song/SongSheet';
import { SongSurface } from '../features/song/SongSurface';
import {
  MODE_POSE,
  PLAYER_TRANSPORT_KNOBS,
  PLAYER_VERB_POSE,
} from '../features/field/NativePlayer';
import { JobSheet, JOB_SHEET_KNOBS } from '../features/field/JobSheet';
import { CAMERA_SUMMARY_KNOBS } from '../features/field/cameraSummary';
import { jobStateLabel } from '../jobs/policy';
import { shelfLabel } from '../features/field/shelfLabels';
import {
  DEFAULT_ORDER_KEY,
  GRAIN_ENABLED,
  arrangementByKey,
  byDate,
  byPlaylist,
  byTime,
  columnsFor,
  gatherFraction,
  grainWindow,
  layoutField,
  orderByKey,
  queueFrom,
  representationAlphas,
  placementPoint,
  stepFrom,
  visibleSecondsAt,
  worldToScreen,
  type DateResolution,
  type Placement,
  type QueueStep,
  type Viewport,
} from '../field';
import {
  allPlaylists,
  allTags,
  normalise,
  playlistNameProblem,
  playlistsOf,
  tagNameProblem,
} from '../playlists';
import type { SongDetail, SongHeader } from '../core/protocol';
import type { SongPatch } from '../../../protocol/SongPatch';
import type { AppIdentity } from '../identity/derive';
import {
  DEFAULT_LENS_KEY,
  analyseWindow,
  arrivingFraction,
  availabilityAction,
  availabilityOf,
  formatBytes,
  type AvailabilityAction,
} from '../lenses';
import { AnalysisStore, type AnalysisRef } from '../lenses/analysisStore';
import { createAsyncStorage } from '@react-native-async-storage/async-storage';
import type { ArtifactView } from '../../../protocol/ArtifactView';
import { shallowEqual, useStore } from '../core/useStore';
import type { Store } from '../core/store';
import type { BackendRuntimeState } from '../runtime/backendRuntime';
import {
  DEFAULT_AUDIO_CACHE_BYTES,
  loadAudioBudget,
  saveAudioBudget,
} from '../audio/budget';
import { audioKey } from '../audio/repository';
import {
  DEFAULT_AFTER_SONG,
  createAudioApiPlayer,
  loadAfterSong,
  nextAfterSong,
  PlayerHost,
  saveAfterSong,
  usePlayer,
  type AfterSong,
} from '../player';
import { useRuntime } from '../runtime';
import { readError } from '../core/errors';
import { space, usePalette } from '../theme/tokens';

type Props = {
  identity: AppIdentity;
};

/** KNOBS */
/**
 * The resolution a song is measured at: 3⁶, so the seal's base-3 grid and the
 * Cantor intervals both divide it into whole buckets.
 */
const ANALYSIS_BUCKETS = 729;
/**
 * How long the arriving arc takes to reach each published progress sample.
 *
 * Matched to the runtime's publishing interval so the arc is always just
 * finishing the last step as the next one lands: shorter and it stands still
 * between samples, longer and it lags the number it is drawing.
 */
const ARRIVING_GLIDE_MS = 100;
/**
 * How far the player's hand moves between two redraws, in physical pixels of
 * the ring. The canvas redraws once per step, so this is smoothness against
 * heat: on the Xiaomi at L2, 1 px held ~80% of a core, 2 px ~60%, 4 px ~51%.
 */
const PLAYHEAD_STEP_PX = 2;

/** Where song measurements are kept, apart from every other stored key. */
const ANALYSIS_DATABASE = 'cantor-analysis';

type AnalysisSource =
  | Readonly<{ kind: 'node'; song: SongHeader; artifact: ArtifactView }>
  | Readonly<{ kind: 'device'; path: string; durationMs: number }>;

/** How to measure a song, when its audio is on the phone to measure. */
function analysisRefOf(
  presentation: FieldPresentation,
): AnalysisRef<AnalysisSource> | null {
  const ref = audioRefOf(presentation);
  const state = presentation.localAudio.state;
  if (ref === null || (state !== 'cached' && state !== 'pinned')) {
    return null;
  }
  return {
    entityKey: presentation.entity.key,
    nodePublicKey: ref.nodeKey,
    songId: ref.songId,
    artifactDigest: ref.digest,
    resolution: ANALYSIS_BUCKETS,
    source:
      presentation.source === 'device'
        ? {
            kind: 'device',
            path: presentation.device.path,
            durationMs: presentation.durationMs,
          }
        : {
            kind: 'node',
            song: presentation.song,
            artifact: presentation.delivery!,
          },
  };
}

/**
 * The field canvas with the jobs it draws, read here rather than in
 * `FieldScreen`: a job's progress re-renders this, and the canvas takes the
 * new mark through a shared value (`jobMarks`), not the screen around it.
 */
function LiveFieldCanvas({
  controllerStore,
  ...props
}: Omit<React.ComponentProps<typeof FieldCanvas>, 'jobs'> & {
  controllerStore: FieldControllerStore;
}) {
  const jobs = useStore(controllerStore.store, jobsOf);
  return <FieldCanvas {...props} jobs={jobs} />;
}

function jobsOf(controller: FieldController) {
  return controller.jobs;
}

/**
 * The engines sheet with each node's live snapshot — while it is open. It
 * stays mounted closed, and a closed sheet has no reason to re-render on
 * every job tick; opening it reads the snapshots as they are then.
 */
function LiveEnginesSheet({
  runtimeStore,
  ...props
}: Omit<React.ComponentProps<typeof EnginesSheet>, 'snapshots'> & {
  runtimeStore: Store<BackendRuntimeState>;
}) {
  const snapshots = useStore(
    runtimeStore,
    state => state.snapshots,
    (left, right) => !props.open || left === right,
  );
  return <EnginesSheet {...props} snapshots={snapshots} />;
}

/** Each paired node's connection phase: what readiness is read from. */
function phasesOf(state: BackendRuntimeState): Record<string, string> {
  const phases: Record<string, string> = {};
  for (const [key, snapshot] of Object.entries(state.snapshots)) {
    phases[key] = snapshot.phase;
  }
  return phases;
}

/** What of the controller changes with the library, not with a job's progress. */
function songsOf(controller: FieldController) {
  return {
    entities: controller.entities,
    presentations: controller.presentations,
  };
}

function everything<T>(state: T): T {
  return state;
}

/** The post-onboarding surface: one field, no parallel console navigation. */
export function FieldScreen({ identity }: Props) {
  const pal = usePalette();
  /*
   * The runtime, and only the parts of it this screen shows.
   *
   * Read whole, every change it published re-rendered the whole screen — a
   * running job's progress about once a second. So each part is selected on
   * its own, and what changes with a job (its snapshot, its mark) is read by
   * the components that draw it: `LiveFieldCanvas`, the job sheet's selector,
   * `LiveEnginesSheet`.
   */
  const runtime = useRuntime(identity);
  const commands = runtime.commands;
  const backends = useStore(runtime.store, state => state.backends);
  const phases = useStore(runtime.store, phasesOf, shallowEqual);
  const pairing = useStore(runtime.store, state => state.pairing);
  const storageError = useStore(runtime.store, state => state.storageError);
  const refreshing = useStore(runtime.store, state =>
    Object.values(state.snapshots).some(snapshot => snapshot.librarySyncing),
  );
  const [viewport, setViewport] = useState<Viewport | null>(null);
  // One player for the life of the screen. A second one would be a second
  // element and a second audio session.
  const player = useMemo(() => createAudioApiPlayer(), []);
  const transport = usePlayer(player);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * The caption in flight, from the moment it is sent until it has become a
   * mark. `jobKey` is filled in when the node names the job.
   */
  const [condensing, setCondensing] = useState<{
    caption: string;
    nodePublicKey: string;
    jobKey: string | null;
  } | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  /**
   * The song the sheet is open on, and the cluster it was opened from.
   *
   * A subject rather than a flag: the sheet used to be reachable only from the
   * player, so "the focused song" was the only song it could mean. A hold at
   * L0 opens it on a song the camera is nowhere near, and the placement is
   * what says which of a song's several marks was held.
   */
  const [sheetTarget, setSheetTarget] = useState<{
    entityKey: string;
    groupKey: string | null;
  } | null>(null);
  const [songDetail, setSongDetail] = useState<SongDetail | null>(null);
  const [songDetailError, setSongDetailError] = useState<string | null>(null);
  /**
   * Why the last act on this song did not happen.
   *
   * Kept apart from `songDetailError`, which is the node's answer about the
   * recipe: a refused rename is not a fact about the recipe, and since the
   * recipe moved to the sheet's second page, reporting a refused act through
   * it meant a toggle could fail on a page you were not looking at.
   */
  const [songProblem, setSongProblem] = useState<string | null>(null);
  /**
   * The act on the sheet's song that is running, if one is: an audio act, or
   * ending it.
   *
   * A name rather than a flag, because the sheet draws the two sides of it
   * differently: the act that is running *works* — it keeps its ink and grows
   * a rule — and every other act is merely out of reach. A boolean could only
   * say "something", which is how the button you pressed used to go grey along
   * with everything it had locked out.
   *
   * Patching does not belong here. A `song.patch` is guarded by
   * `expected_revision`, so two in flight on one song is a real fault — but the
   * cure is a queue, not a frozen sheet, and `useSongWish` owns that queue.
   */
  const [songAct, setSongAct] = useState<SongAct | null>(null);
  const [lensKey, setLensKey] = useState(DEFAULT_LENS_KEY);
  const [arrangementKey, setArrangementKey] = useState(byTime.key);
  /**
   * How members are seated, and the seed a random seating is held at.
   *
   * The seed changes only when random is asked for again, which is what makes
   * a shuffle an order rather than a re-roll on every render.
   */
  const [orderKey, setOrderKey] = useState<string>(DEFAULT_ORDER_KEY);
  /** The cache ceiling, read once and written when it is changed. */
  const [budgetBytes, setBudgetBytes] = useState(DEFAULT_AUDIO_CACHE_BYTES);
  useEffect(() => {
    let active = true;
    void loadAudioBudget().then(bytes => {
      if (active) setBudgetBytes(bytes);
    });
    return () => {
      active = false;
    };
  }, []);
  const changeBudget = useCallback((bytes: number) => {
    setBudgetBytes(bytes);
    saveAudioBudget(bytes).catch(error => setAudioError(readError(error)));
  }, []);

  /**
   * The generation whose detail is open, if any, and whether its blind is down.
   *
   * Two states for the same reason the song sheet has two: dropping the subject
   * is not how a blind closes. The mark is retained for the length of the run,
   * so the sheet rolls away instead of vanishing out of the tree.
   */
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [jobOpen, setJobOpen] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  /** Its own blind, for the reason `sheetPull` is its own: one number each. */
  const jobPull = useSharedValue(0);
  const jobDestination = useSharedValue(0);
  const closeJobSheet = useCallback(() => setJobOpen(false), []);
  useEffect(() => {
    if (jobOpen || jobKey === null) return;
    const home = setTimeout(() => {
      setJobKey(null);
      setJobError(null);
    }, JOB_SHEET_KNOBS.BLIND_MS);
    return () => clearTimeout(home);
  }, [jobKey, jobOpen]);
  const [orderSeed, setOrderSeed] = useState(() => Date.now());
  const chooseOrder = useCallback((key: string) => {
    setOrderKey(current => {
      if (key === 'random' && current === 'random') {
        // Asking for random again is asking for a different random.
        setOrderSeed(Date.now());
      }
      return key;
    });
  }, []);
  const [dateResolution, setDateResolution] = useState<DateResolution>('week');
  /**
   * The decoded L3 window, on the UI thread.
   *
   * Never through React: a decode lands while the camera is moving, and a prop
   * change there hands `Canvas` a fresh element and re-records the whole root.
   */
  const grainShared = useSharedValue<GrainBars | null>(null);
  /**
   * The song sheet's own blind.
   *
   * It cannot ride the field's edge pull the way the composer and the engines
   * do: that value already carries the engines blind at this same edge, and
   * two bottom blinds reading one number would answer each other's gestures.
   * Nothing writes these but `Curtain`'s own run and its grip.
   */
  const sheetPull = useSharedValue(0);
  const sheetDestination = useSharedValue(0);
  /** Rows whose audio command is in flight, so a second tap cannot double it. */
  const audioBusy = useRef(new Set<string>());
  const [audioError, setAudioError] = useState<string | null>(null);
  /**
   * Every song's measurement: read back from disk, or decoded one at a time.
   * See `AnalysisStore`.
   */
  const analysisStore = useMemo(
    () =>
      new AnalysisStore<AnalysisSource>(async ref => {
        const source = ref.source;
        // A device song is its own file; a node song's path is asked of native
        // storage, which answers only for a whole, verified artifact.
        const localPath =
          source.kind === 'device'
            ? source.path
            : await commands.audioPath(
                ref.nodePublicKey,
                source.song,
                source.artifact,
              );
        const durationMs =
          source.kind === 'device'
            ? source.durationMs
            : source.song.duration_ms;
        const window = await player.samples({
          ref: {
            nodeKey: ref.nodePublicKey,
            songId: ref.songId,
            digest: ref.artifactDigest,
          },
          localPath,
          startSeconds: 0,
          endSeconds: durationMs / 1000,
          buckets: ANALYSIS_BUCKETS,
        });
        return analyseWindow(window);
      }, createAsyncStorage(ANALYSIS_DATABASE)),
    [commands, player],
  );
  useEffect(() => () => analysisStore.dispose(), [analysisStore]);
  const analyses = useStore(analysisStore.store, everything);
  /*
   * The field's projection of the runtime: songs and entities here, which a
   * job's progress leaves as the same objects; the jobs where they are drawn.
   */
  /*
   * The songs whose files live on this phone (device import, docs/import/).
   * Opened once; if the database cannot be opened the field shows node songs
   * only, as it did before import existed.
   */
  const [deviceLibrary] = useState(
    () =>
      new DeviceLibraryService({
        openRepository: async () =>
          createDeviceRepository(await openPhoneDatabase()),
        media: nativeMedia,
        now: () => Date.now(),
      }),
  );
  useEffect(() => {
    deviceLibrary.start().catch(error => {
      console.warn('device library unavailable', readError(error));
    });
  }, [deviceLibrary]);
  const [controllerStore] = useState(() =>
    createFieldControllerStore(runtime.store, deviceLibrary.store),
  );
  useEffect(() => controllerStore.connect(), [controllerStore]);
  const controller = useStore(controllerStore.store, songsOf, shallowEqual);
  /**
   * What the phone thinks the time is, for labels that read relatively.
   *
   * Re-read when the library changes rather than on a timer: a clock ticking
   * in state would re-record the field picture every minute for a word that
   * changes once a week, and the library changing is the only moment the
   * screen is already re-rendering *and* a week boundary could have passed
   * unnoticed.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [controller.entities]);
  const layout = useMemo(() => {
    if (viewport === null) return null;
    // Resolution is a property of the date axis, so it is applied here rather
    // than being a third entry in the registry.
    const arrangement =
      arrangementKey === byTime.key
        ? byDate(dateResolution)
        : arrangementByKey(arrangementKey) ?? byTime;
    return layoutField({
      entities: controller.entities,
      arrangement,
      viewport,
      order: orderByKey(orderKey),
      orderSeed,
    });
  }, [
    arrangementKey,
    controller.entities,
    dateResolution,
    orderKey,
    orderSeed,
    viewport,
  ]);

  const openComposer = useCallback(() => {
    setSubmitError(null);
    setComposerOpen(true);
  }, []);

  /** What each paired node advertises, which is what the composer validates against. */
  const composerTargets = useMemo<readonly ComposerTarget[]>(
    () =>
      (backends ?? []).map(backend => {
        const info = backend.lastNodeInfo;
        return {
          nodePublicKey: backend.nodePubkey,
          label:
            backend.petname || info?.name || backend.nodePubkey.slice(0, 8),
          ready: phases[backend.nodePubkey] === 'ready',
          models: info?.models ?? [],
          limits: info?.limits ?? null,
        };
      }),
    [backends, phases],
  );

  /**
   * Send one generation.
   *
   * Routed through `runtime.submit` so the persisted outbox and its idempotency
   * behaviour stay intact: a submission survives the app dying between the tap
   * and the node's answer.
   */
  const submitDraft = useCallback(
    async (
      nodePublicKey: string,
      modelSelector: string,
      generation: Parameters<typeof commands.submit>[2],
    ) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        setCondensing({
          caption: generation.caption,
          nodePublicKey,
          jobKey: null,
        });
        setComposerOpen(false);
        await commands.submit(nodePublicKey, modelSelector, generation);
      } catch (error) {
        setCondensing(null);
        setSubmitError(error instanceof Error ? error.message : String(error));
      } finally {
        setSubmitting(false);
      }
    },
    [commands],
  );
  const openEngines = useCallback(() => setEnginesOpen(true), []);
  const closeEngines = useCallback(() => setEnginesOpen(false), []);
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  /**
   * Whether the song sheet's blind is down, kept apart from which song it
   * holds.
   *
   * Dropping the subject is what used to close it, which meant the whole
   * Curtain left the tree in the commit that asked it to close and the blind
   * never ran — the sheet vanished instead of rolling away. The song is
   * retained for the length of that run, the same way the player retains its
   * outgoing `playerKey` until the camera reaches the shelf seat.
   */
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSongSheet = useCallback(() => setSheetOpen(false), []);

  // Let go of the subject when the blind is home, not when it is asked to go:
  // the run is a `withTiming` of a length this can ask for, so the two agree
  // by construction rather than by a number typed twice.
  useEffect(() => {
    if (sheetOpen || sheetTarget === null || viewport === null) return;
    const home = setTimeout(
      () => setSheetTarget(null),
      SONG_SHEET_KNOBS.BLIND_MS,
    );
    return () => clearTimeout(home);
  }, [sheetOpen, sheetTarget, viewport]);
  const pairFromEngines = useCallback(() => {
    setEnginesOpen(false);
    commands.showPairing();
  }, [commands]);
  const onComposerSubmit = useCallback<
    React.ComponentProps<typeof ComposerSheet>['onSubmit']
  >(
    (nodePublicKey, modelSelector, generation) =>
      void submitDraft(nodePublicKey, modelSelector, generation),
    [submitDraft],
  );
  /**
   * One row's audio action, from the word at the end of the row.
   *
   * `GET` downloads *and* pins, because asking for a song is the definition of
   * a download: cached is what you get by listening. `KEEP` promotes the loan
   * the budget may reclaim into the promise it may not, and `REMOVE` takes the
   * bytes off the phone — the megabytes the row names are the ones it frees.
   *
   * Both compound verbs are compositions rather than new commands: native
   * storage refuses to delete a pinned artifact outright — `removeCached` says
   * *"Unpin this artifact before removing it"* — so `REMOVE` unpins first, and
   * pinning requires a verified cached file, so `GET` downloads first — as one
   * runtime act (`keep`), so the row never reads "cached" on its way to kept.
   */
  const runRowAudio = useCallback(
    async (presentation: FieldPresentation, action: AvailabilityAction) => {
      // A device song's file is its own; there is nothing to fetch or free.
      if (presentation.source !== 'node') return;
      const artifact = presentation.delivery;
      if (artifact === undefined) return;
      const key = presentation.entity.key;
      // A second tap on a row already working would submit the same transfer
      // twice; the runtime would survive it, the row would not read honestly.
      if (audioBusy.current.has(key)) return;
      audioBusy.current.add(key);
      setAudioError(null);
      const run = (verb: Parameters<typeof commands.audio>[3]) =>
        commands.audio(
          presentation.entity.nodePublicKey,
          presentation.song,
          artifact,
          verb,
        );
      try {
        if (action === 'GET') {
          await run('keep');
        } else if (action === 'KEEP') {
          await run('pin');
        } else {
          // Never delete a file the player still holds open.
          const track = transport.snapshot.track;
          if (
            track?.nodeKey === presentation.entity.nodePublicKey &&
            track?.songId === presentation.entity.entityId
          ) {
            await transport.close();
          }
          if (presentation.localAudio.state === 'pinned') await run('unpin');
          await run('remove');
        }
      } catch (error) {
        setAudioError(readError(error));
      } finally {
        audioBusy.current.delete(key);
      }
    },
    [commands, transport],
  );

  const onRowAction = useCallback(
    (placement: Placement): boolean => {
      const presentation = controller.presentations.get(placement.entityKey);
      if (
        presentation === undefined ||
        !presentation.audioActions ||
        !presentation.playable
      ) {
        return false;
      }
      const action = availabilityAction(
        availabilityOf(presentation.localAudio.state),
      );
      if (action === null) return false;
      void runRowAudio(presentation, action);
      return true;
    },
    [controller.presentations, runRowAudio],
  );

  /**
   * Forget an engine, letting go of anything of its the player still holds.
   *
   * `forgetBackend` releases every copy of that node's audio that was only
   * borrowed, and deleting a file out from under an open track is the one thing
   * `runRowAudio`'s `REMOVE` already refuses to do. A *pinned* song survives the
   * forget, so playing one is not interrupted by it: unpairing an engine is not
   * a reason to stop the music you own.
   *
   * The camera needs no help here. A song that leaves the field takes its
   * placement with it, and `useFieldCamera` climbs out of a song it can no
   * longer find rather than hanging at that distance over nothing.
   */
  const forgetEngine = useCallback(
    async (nodePublicKey: string) => {
      const track = transport.snapshot.track;
      if (track?.nodeKey === nodePublicKey) {
        const playing = controller.presentations.get(
          `${track.nodeKey}:${track.songId}`,
        );
        if (playing?.localAudio.state !== 'pinned') await transport.close();
      }
      await commands.forgetBackend(nodePublicKey);
    },
    [commands, controller.presentations, transport],
  );

  /** A generating mark opens what it is doing; it has no inside to descend to. */
  const onClaimTap = useCallback(
    (placement: Placement): boolean => {
      // Read at the tap: the screen does not re-render for jobs.
      if (!controllerStore.store.get().jobs.has(placement.entityKey)) {
        return false;
      }
      setJobError(null);
      setJobKey(placement.entityKey);
      setJobOpen(true);
      return true;
    },
    [controllerStore],
  );

  /** Hold acts: everything about a song that is not the act of listening. */
  const onHoldPlacement = useCallback((placement: Placement) => {
    setPlaybackError(null);
    setSheetOpen(true);
    setSheetTarget({
      entityKey: placement.entityKey,
      groupKey: placement.groupKey,
    });
  }, []);

  const fieldCamera = useFieldCamera({
    layout,
    viewport,
    onOpenComposer: openComposer,
    onOpenEngines: openEngines,
    onRowAction,
    onHoldPlacement,
    onClaimTap,
  });
  // The overlay button drops any gesture in flight before the sheet arrives.
  const { cancelGesture } = fieldCamera;
  const openEnginesFromField = useCallback(() => {
    cancelGesture();
    openEngines();
  }, [cancelGesture, openEngines]);
  /**
   * The placement the player is showing — which outlives the focus by a flight.
   *
   * Leaving a song clears the camera's focus at once, because the canvas mounts
   * the player on it and a song you have left must stop being the player the
   * moment you turn around. But this surface is the player's *words*, and they
   * fade out on the song band over the whole climb back to the shelf. Read
   * straight from the focus they would not fade at all: they would vanish on
   * the first commit after the back press, at full opacity, with the ring they
   * belong to still filling the screen.
   *
   * So the last placement is held, and `songAlpha` below decides how long it
   * matters — which it already did. The band closes at `12·FIT` and takes this
   * with it; a descent into a different song replaces the held placement long
   * before the band reopens.
   */
  const heldFocus = useRef<Placement | null>(null);
  if (fieldCamera.focus !== null) heldFocus.current = fieldCamera.focus;
  const playerPlacement = fieldCamera.focus ?? heldFocus.current;
  // The song the camera is focused on, if the field still knows about it.
  const focused = useMemo(() => {
    const key = playerPlacement?.entityKey;
    return key === undefined ? null : controller.presentations.get(key) ?? null;
  }, [controller.presentations, playerPlacement]);

  /**
   * How present the player is, 0..1, from the same band the canvas draws from.
   *
   * `representationAlphas` has computed this since the beginning and nothing
   * read it: `SongSurface` mounted on `level === 'song'`, which is `13·FIT` —
   * where the row is still at 0.998 and the song at 0.003 — so the player cut
   * in seven units of FIT before its own crossfade would have begun. Reading
   * the band is the whole of the seam: the row grows into the player across
   * `12→27·FIT`, chrome and picture on one number.
   */
  const songAlpha = useMemo(
    () =>
      representationAlphas(fieldCamera.camera.scale, fieldCamera.renderFitScale)
        .song,
    [fieldCamera.camera.scale, fieldCamera.renderFitScale],
  );

  /** The generation its sheet is open on, if the field still knows about it. */
  const pendingJob = useStore(controllerStore.store, current =>
    jobKey === null ? null : current.jobs.get(jobKey) ?? null,
  );

  /** The song the sheet is open on, if the field still knows about it. */
  const sheetSong = useMemo(
    () =>
      sheetTarget === null
        ? null
        : controller.presentations.get(sheetTarget.entityKey) ?? null,
    [controller.presentations, sheetTarget],
  );

  /**
   * What the sheet is allowed to say about scope.
   *
   * A mark is a `(song, group)` pair, so the same song can be three marks in
   * three clusters. The sheet names the one that was held, counts the rest,
   * and — when that cluster is a playlist — offers to leave just that one.
   */
  const sheetScope = useMemo(() => {
    if (sheetSong === null) {
      return {
        label: null as string | null,
        playlist: null as string | null,
        placements: 0,
        playlists: 0,
      };
    }
    const group =
      sheetTarget?.groupKey === undefined || layout === null
        ? undefined
        : layout.groups.find(
            candidate => candidate.key === sheetTarget.groupKey,
          );
    const playlists = playlistsOf(sheetSong.entity.tags);
    const onPlaylistAxis = arrangementKey === byPlaylist.key;
    const isPlaylistGroup =
      onPlaylistAxis &&
      group !== undefined &&
      playlists.some(name => name === group.label);
    return {
      label:
        group === undefined ? null : shelfLabel(group.label, nowMs).primary,
      playlist: isPlaylistGroup ? group.label : null,
      placements:
        layout?.placements.filter(
          placement => placement.entityKey === sheetSong.entity.key,
        ).length ?? 1,
      playlists: playlists.length,
    };
  }, [arrangementKey, layout, nowMs, sheetSong, sheetTarget]);

  /**
   * What the node is holding for this song, which is the master rather than the
   * delivery. Both are in `artifacts`; only this one is the number that says
   * what ending the song frees over there.
   */
  function masterBytesOf(song: SongHeader): number | null {
    const master = song.artifacts.find(artifact => artifact.kind === 'master');
    return master?.byte_length ?? null;
  }

  /** Every playlist that exists, which is every `p/` tag on every song. */
  const knownPlaylists = useMemo(
    () => allPlaylists(controller.entities.map(entity => entity.tags)),
    [controller.entities],
  );

  /** Every word anyone has used, so the tag peel opens onto a vocabulary. */
  const knownTags = useMemo(
    () => allTags(controller.entities.map(entity => entity.tags)),
    [controller.entities],
  );

  const currentTrack = transport.snapshot.track;
  // One key lights every placement of that song, which is what M6 needs when a
  // song sits in several playlists at once.
  /**
   * The song the player holds — playing *or* paused.
   *
   * `LensSong.playing` has always documented itself as "the song the player
   * currently holds", and this was reading `state === 'playing'`: pausing
   * dropped the key, which dropped the ring at L0 and L1 and took the player's
   * progress with it. Holding is not the same as sounding.
   */
  const heldKey =
    currentTrack !== null
      ? `${currentTrack.nodeKey}:${currentTrack.songId}`
      : null;
  const playingKey = heldKey;
  const focusedIsCurrent =
    focused !== null &&
    currentTrack !== null &&
    currentTrack.nodeKey === focused.entity.nodePublicKey &&
    currentTrack.songId === focused.entity.entityId;
  /**
   * The transport's morph, on the UI thread: see `PLAYER_VERB_POSE`.
   *
   * A shared value rather than a prop, because the canvas draws the transport
   * and a prop is a React commit — which re-records the whole canvas from
   * whatever the JS thread last held. The word this replaced did exactly that
   * on every press. Here the press moves one number and the geometry follows
   * it on the UI thread, and a second press mid-morph retargets from wherever
   * the shape had got to rather than snapping back.
   *
   * Only the song the port actually holds is ever the pause pose. Opening a
   * different song leaves this at play, which is what its transport means.
   */
  const idlePositionCandidate = useSharedValue(0);
  const idlePosition = useRef(idlePositionCandidate).current;
  const focusedPosition = focusedIsCurrent
    ? transport.positionSeconds
    : idlePosition;
  /**
   * The playhead, stepped to `PLAYHEAD_STEP_PX` physical pixels of the
   * player's ring.
   *
   * The canvas redraws whenever the playhead moves, and the clock moves every
   * frame — 120 a second on this phone — while the hand it draws travels about
   * eighteen pixels a second on a two-minute song. Nearly every one of those
   * redraws painted the same image, and at L2 that held a whole core (99%,
   * measured). Stepped, the value holds still between steps, a shared value
   * set to what it holds wakes nothing, and the ring redraws only when the
   * hand has somewhere new to be.
   */
  const playheadStepSeconds =
    viewport === null || transport.snapshot.durationSeconds <= 0
      ? 0
      : (transport.snapshot.durationSeconds * PLAYHEAD_STEP_PX) /
        (2 * Math.PI * playerRadiusPx(viewport.width) * PixelRatio.get());
  const steppedCandidate = useSharedValue(0);
  const steppedPosition = useRef(steppedCandidate).current;
  useAnimatedReaction(
    () => {
      const seconds = transport.positionSeconds.value;
      return playheadStepSeconds > 0
        ? Math.round(seconds / playheadStepSeconds) * playheadStepSeconds
        : seconds;
    },
    next => {
      steppedPosition.value = next;
    },
    [playheadStepSeconds],
  );
  /**
   * The playhead the canvas reads: the moving clock only while the canvas owns
   * the player of the song being heard.
   *
   * Everything the canvas draws from the clock belongs to the player — the
   * ring's hand and arc, the heard dots of the seal — but a picture that reads
   * it is re-recorded on every tick, and the faces' picture holds the whole
   * field. Handed the moving clock at L0, it re-drew every mark sixty times a
   * second for as long as a song played (105% of a core, measured). The
   * owner's lifetime is `playerFocus`, which changes on the same commit as the
   * canvas's own focus, so this switch adds no hand-off of its own.
   */
  const canvasPosition =
    heldKey !== null && fieldCamera.playerFocus?.entityKey === heldKey
      ? steppedPosition
      : idlePosition;
  const transportPlaying = useSharedValue<number>(PLAYER_VERB_POSE.play);
  const reducedMotion = useReducedMotion();
  /*
   * A song whose bytes are actually on their way is not offering to start
   * anything, so the verb closes onto the waiting mark and the arc around the
   * face carries how far along it is. Only the focused song is drawn here, and
   * a song that is arriving is never the one making sound, so the three poses
   * stay mutually exclusive and one ramp can hold all of them.
   *
   * Read from the live transfer and not from `partial`: a download interrupted
   * at 24% leaves bytes on disk for good, and keying the closed verb off those
   * would leave a dead mark on a song you can still press to resume — which
   * looks exactly like a hang. The arc still draws from the bytes, because
   * "you have this much" is true whether or not anything is moving.
   */
  const focusedArriving = useStore(
    runtime.store,
    state =>
      focused?.source === 'node' &&
      focused.delivery !== undefined &&
      state.downloading.has(
        audioKey(
          focused.entity.nodePublicKey,
          focused.entity.entityId,
          focused.delivery.sha256,
        ),
      ),
  );
  useEffect(() => {
    const target = focusedArriving
      ? PLAYER_VERB_POSE.waiting
      : focusedIsCurrent && transport.snapshot.state === 'playing'
      ? PLAYER_VERB_POSE.pause
      : PLAYER_VERB_POSE.play;
    if (transportPlaying.value === target) return;
    cancelAnimation(transportPlaying);
    transportPlaying.value = reducedMotion
      ? target
      : withTiming(target, {
          duration: PLAYER_TRANSPORT_KNOBS.MORPH_MS,
          easing: Easing.inOut(Easing.cubic),
        });
  }, [
    focusedArriving,
    focusedIsCurrent,
    reducedMotion,
    transport.snapshot.state,
    transportPlaying,
  ]);

  /**
   * How far the focused song has arrived, on the UI thread.
   *
   * Runtime publishes progress about ten times a second, which is the right
   * rate to *rebuild* a field at and far too slow to *draw* an arc at: stepped
   * ten times a second the ring reads as a stutter, not as a download. So each
   * sample is a target rather than a position, and the arc glides to it over
   * the interval the next one is due in — the same split the playhead makes
   * between the port's resync points and its own clock.
   */
  const transportArriving = useSharedValue(0);
  const focusedArrivingFraction =
    focused === null || focused.localAudio.state !== 'partial'
      ? null
      : arrivingFraction(
          focused.localAudio.bytes,
          focused.byteLength ?? undefined,
        );
  useEffect(() => {
    if (focusedArrivingFraction === null) {
      cancelAnimation(transportArriving);
      transportArriving.value = 0;
      return;
    }
    cancelAnimation(transportArriving);
    transportArriving.value = reducedMotion
      ? focusedArrivingFraction
      : withTiming(focusedArrivingFraction, {
          duration: ARRIVING_GLIDE_MS,
          easing: Easing.linear,
        });
  }, [focusedArrivingFraction, reducedMotion, transportArriving]);

  /** What happens when a song runs off its end; read once, written on change. */
  const [afterSong, setAfterSong] = useState<AfterSong>(DEFAULT_AFTER_SONG);
  useEffect(() => {
    let active = true;
    loadAfterSong().then(mode => {
      if (active) setAfterSong(mode);
    });
    return () => {
      active = false;
    };
  }, []);
  const cycleAfterSong = useCallback(() => {
    setAfterSong(current => {
      const next = nextAfterSong(current);
      saveAfterSong(next).catch(error => setPlaybackError(readError(error)));
      return next;
    });
  }, []);

  /**
   * A verified local path for a song, fetching it first if the phone lacks it.
   *
   * Download belongs to the runtime and playback belongs to the player; this is
   * the seam between them, and the only place they meet. The path is asked for
   * *first* and native storage answers it only for a whole, verified file — so
   * a song already on the phone plays with its node offline, and the decision
   * never rests on a presentation that may be a render old by the time an
   * advance fires in a pocket.
   */
  const fetchPath = useCallback(
    async (presentation: FieldPresentation): Promise<string> => {
      if (presentation.source === 'device') return presentation.device.path;
      const artifact = presentation.delivery;
      if (artifact === undefined) {
        throw new Error('This song has no delivery audio yet.');
      }
      const song = presentation.song;
      const where = () =>
        commands.audioPath(presentation.entity.nodePublicKey, song, artifact);
      try {
        return await where();
      } catch {
        await commands.audio(
          presentation.entity.nodePublicKey,
          song,
          artifact,
          'download',
        );
        return where();
      }
    },
    [commands],
  );
  const prefetch = useCallback(
    async (presentation: FieldPresentation) => {
      if (presentation.source !== 'node') return;
      const artifact = presentation.delivery;
      if (artifact === undefined) return;
      await commands.audio(
        presentation.entity.nodePublicKey,
        presentation.song,
        artifact,
        'download',
      );
    },
    [commands],
  );

  /**
   * The camera follows the queue only if you were watching the song that ended.
   *
   * At L0 and L1 nothing has to move — the ring already travels to whichever
   * mark the player holds. At L2 on that song the player steps down its shelf
   * to the next one. Looking at any other song, you are left where you are.
   *
   * With the screen off the step waits for the app to come back: a flight is
   * frames, and a backgrounded app draws none, so it would otherwise run the
   * moment the screen woke and look like something happening on its own.
   */
  const pendingFollow = useRef<Readonly<{
    from: string;
    to: Placement;
  }> | null>(null);
  const cameraStep = fieldCamera.step;
  const cameraStepping = fieldCamera.stepping;
  const cameraFocusKey = useRef<string | null>(null);
  cameraFocusKey.current = fieldCamera.focus?.entityKey ?? null;
  const followQueue = useCallback(
    (fromEntityKey: string, to: QueueStep) => {
      if (to.placement === null) return;
      // Where the camera is, in intent: a follow still waiting for the
      // screen, then a step on its way, then wherever it actually stands.
      const pending = pendingFollow.current;
      const watching =
        pending?.to.entityKey ??
        cameraStepping()?.entityKey ??
        cameraFocusKey.current;
      if (watching !== fromEntityKey) return;
      if (AppState.currentState === 'active') {
        pendingFollow.current = null;
        cameraStep(to.placement);
      } else {
        // Songs can change several times in a pocket; the camera goes once,
        // from where it stood to where the music is when the screen returns.
        pendingFollow.current = {
          from: pending?.from ?? fromEntityKey,
          to: to.placement,
        };
      }
    },
    [cameraStep, cameraStepping],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      const follow = pendingFollow.current;
      if (next !== 'active' || follow === null) return;
      pendingFollow.current = null;
      if (cameraFocusKey.current === follow.from) cameraStep(follow.to);
    });
    return () => subscription.remove();
  }, [cameraStep]);

  const queue = useShelfQueue({
    player,
    transport,
    afterSong,
    layout,
    presentations: controller.presentations,
    fetchPath,
    prefetch,
    onMove: followQueue,
    onError: setPlaybackError,
  });
  const skipFromLockScreen = useCallback(
    (direction: 1 | -1) => {
      queue.skip(direction).catch(() => undefined);
    },
    [queue],
  );

  /**
   * Whether the focused song has a neighbour to step to, each way.
   *
   * Previous is always live on the song that is playing, because back from
   * there is its own top. The drawn steps fade on a shared value — see
   * `transportLights` — so this changing costs the canvas nothing.
   */
  const focusedSteps = useMemo(() => {
    if (layout === null || playerPlacement === null || focused === null) {
      return { previous: false, next: false };
    }
    const shelf = queueFrom(layout, playerPlacement);
    const playable = (key: string) =>
      controller.presentations.get(key)?.playable === true;
    const from = playerPlacement.entityKey;
    return {
      previous:
        focusedIsCurrent ||
        stepFrom(shelf, layout, from, -1, playable) !== null,
      next: stepFrom(shelf, layout, from, 1, playable) !== null,
    };
  }, [
    controller.presentations,
    focused,
    focusedIsCurrent,
    layout,
    playerPlacement,
  ]);
  /**
   * `[previous, next, mode]`; see `TransportControls`. One clock for all
   * three, on the transport's own morph time, so a press on the mode retargets
   * from wherever the shape had got to — the same as the verb beside it.
   */
  const transportLights = useSharedValue<number[]>([
    0,
    0,
    MODE_POSE[DEFAULT_AFTER_SONG],
  ]);
  useEffect(() => {
    const next = [
      focusedSteps.previous ? 1 : 0,
      focusedSteps.next ? 1 : 0,
      MODE_POSE[afterSong],
    ];
    transportLights.value = reducedMotion
      ? next
      : withTiming(next, {
          duration: PLAYER_TRANSPORT_KNOBS.MORPH_MS,
          easing: easeSmoother,
        });
  }, [
    afterSong,
    focusedSteps.next,
    focusedSteps.previous,
    reducedMotion,
    transportLights,
  ]);
  const stepFocused = useCallback(
    (direction: 1 | -1) => {
      queue.skip(direction, playerPlacement).catch(() => undefined);
    },
    [playerPlacement, queue],
  );

  /** Play or pause the focused song; a new one makes its shelf the queue. */
  const playFocused = useCallback(async () => {
    if (focused === null || playerPlacement === null) return;
    if (!focused.playable) {
      setPlaybackError('This song has no delivery audio yet.');
      return;
    }
    if (focusedIsCurrent) {
      transport.toggle();
      return;
    }
    await queue.start(focused, playerPlacement);
  }, [focused, focusedIsCurrent, playerPlacement, queue, transport]);

  /**
   * Run one song command, keeping the sheet honest about failure.
   *
   * Every control here mutates node-owned truth, so each one reports its own
   * error rather than failing silently and leaving the sheet showing a state
   * the node never accepted.
   */
  const runSongCommand = useCallback(
    async (act: SongAct, work: () => Promise<void>) => {
      setSongAct(act);
      setSongProblem(null);
      try {
        await work();
      } catch (error) {
        setSongProblem(error instanceof Error ? error.message : String(error));
      } finally {
        setSongAct(null);
      }
    },
    [],
  );

  /**
   * Send one patch the sheet has already drawn, and say if the node refuses it.
   *
   * Deliberately *not* through `runSongCommand`: this act does not take the
   * sheet away while it runs, because the sheet is showing the change already.
   * The error is reported here, where the sheet's problem line reads from, and
   * then re-thrown — `useSongWish` needs the rejection to animate the mark back
   * to what the node actually holds. Swallowing it would leave a tick drawn
   * under a tag the node never accepted.
   *
   * One patch at a time is the caller's guarantee, and it is what keeps
   * `sheetSong.song.revision` fresh enough to be worth sending.
   */
  const commitSheetPatch = useCallback(
    async (patch: SongPatch) => {
      if (sheetSong === null) return;
      setSongProblem(null);
      try {
        if (sheetSong.source === 'device') {
          // Only its tags are Cantor's: the sheet offers nothing else here.
          if (patch.tags !== undefined) {
            await deviceLibrary.setTags(sheetSong.device.id, patch.tags);
          }
          return;
        }
        await commands.patchSong(
          sheetSong.entity.nodePublicKey,
          sheetSong.song,
          patch,
        );
      } catch (error) {
        setSongProblem(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [commands, deviceLibrary, sheetSong],
  );

  /**
   * What the sheet draws a song from. A node song is its header; an imported
   * one is shown through the same shape — its own title, length and tags, a
   * recipe the face is drawn from — so the sheet's membership and face work
   * unchanged, and `imported` says everything else is the file's.
   */
  const sheetHeader = useMemo<SongHeader | null>(() => {
    if (sheetSong === null) return null;
    if (sheetSong.source === 'node') return sheetSong.song;
    return {
      id: sheetSong.device.id,
      revision: 0,
      title: sheetSong.title,
      caption_summary: '',
      created_at: new Date(sheetSong.device.addedAtMs).toISOString(),
      duration_ms: sheetSong.durationMs,
      model: sheetSong.recipe.model,
      favorite: false,
      tags: [...sheetSong.entity.tags],
      trashed: false,
      artifacts: [],
    };
  }, [sheetSong]);
  const sheetImported = useMemo<ImportedFacts | null>(() => {
    if (sheetSong === null || sheetSong.source !== 'device') return null;
    const { device, album } = sheetSong;
    const dot = device.path.lastIndexOf('.');
    return {
      artist: device.artist,
      album: album?.title ?? null,
      year: device.year,
      genre: device.genre,
      format: dot < 0 ? 'FILE' : device.path.slice(dot + 1).toUpperCase(),
      folder: device.path.slice(0, device.path.lastIndexOf('/')),
      bytes: device.size,
      addedAtMs: device.addedAtMs,
    };
  }, [sheetSong]);

  const runAudioAction = useCallback(
    (action: 'pin' | 'unpin' | 'remove') => {
      if (
        sheetSong === null ||
        sheetSong.source !== 'node' ||
        sheetSong.delivery === undefined
      ) {
        return;
      }
      const artifact = sheetSong.delivery;
      const track = transport.snapshot.track;
      const isCurrent =
        track?.nodeKey === sheetSong.entity.nodePublicKey &&
        track?.songId === sheetSong.entity.entityId;
      void runSongCommand(action, async () => {
        // Never delete a file the player still holds open: drop the reference
        // first, then remove. Native storage stays authoritative either way.
        if (action === 'remove' && isCurrent) await transport.close();
        // Native storage refuses to delete a pinned artifact, so removing one
        // from the phone is unpin-then-remove — the same compound the row does.
        if (action === 'remove' && sheetSong.localAudio.state === 'pinned') {
          await commands.audio(
            sheetSong.entity.nodePublicKey,
            sheetSong.song,
            artifact,
            'unpin',
          );
        }
        await commands.audio(
          sheetSong.entity.nodePublicKey,
          sheetSong.song,
          artifact,
          action,
        );
      });
    },
    [commands, runSongCommand, sheetSong, transport],
  );

  // Ask the node for the recipe whenever the sheet opens on a song.
  // Keyed on the sheet's subject, not the camera's: they are no longer the
  // same song.
  useEffect(() => {
    if (sheetSong === null) return;
    let active = true;
    setSongDetail(null);
    setSongDetailError(null);
    setSongProblem(null);
    // An imported song has no recipe and no node to ask.
    if (sheetSong.source !== 'node') return;
    commands
      .getSongDetail(sheetSong.entity.nodePublicKey, sheetSong.entity.entityId)
      .then(detail => {
        if (active) setSongDetail(detail);
      })
      .catch(error => {
        if (active) {
          setSongDetailError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [commands, sheetSong]);

  /**
   * Where the caption in flight should land.
   *
   * Null until the node has named the job *and* the field has laid out a
   * placement for it. Both halves matter: a placement that does not exist yet
   * is not a position to fly to, and guessing one would land the caption
   * somewhere the mark is not.
   */
  const condenseKey = useStore(controllerStore.store, current =>
    condensing === null
      ? null
      : condensing.jobKey ??
        [...current.jobs.keys()].find(candidate =>
          candidate.startsWith(`${condensing.nodePublicKey}:`),
        ) ??
        null,
  );
  const condenseTarget = useMemo(() => {
    if (condenseKey === null || viewport === null) return null;
    const key = condenseKey;
    const placement = fieldCamera.renderedPlacements.find(
      candidate => candidate.entityKey === key,
    );
    if (placement === undefined) return null;
    // The same pose the canvas drew this mark at, or the panel condenses onto
    // the seat the job would have had if its cluster were gathered.
    return worldToScreen(
      placementPoint(
        placement,
        gatherFraction(fieldCamera.camera.scale, fieldCamera.renderFitScale),
      ),
      fieldCamera.camera,
      viewport,
    );
  }, [
    condenseKey,
    fieldCamera.camera,
    fieldCamera.renderedPlacements,
    fieldCamera.renderFitScale,
    viewport,
  ]);

  /**
   * Measure the focused song first, whenever its audio is on the phone.
   *
   * Nothing is ever downloaded in order to decorate a mark: a song whose
   * audio is not here draws the neutral skeleton. The store reads a measurement
   * back from disk when one was ever taken, so this decodes a song once per
   * install rather than once per visit.
   */
  useEffect(() => {
    const ref = focused === null ? null : analysisRefOf(focused);
    if (ref !== null) analysisStore.request(ref);
  }, [analysisStore, focused]);

  /**
   * Resolve the visible slice of audio while the camera is inside a song.
   *
   * The window follows the camera scale, so zooming *is* scrubbing: the request
   * is re-issued as the span changes, and only for the span on screen rather
   * than for the whole song.
   */
  useEffect(() => {
    /*
     * Asked for from the song, not from the grain.
     *
     * The window is decoded off the disk and it is not instant — measured at
     * several seconds for a two-minute song, behind the whole-song analysis
     * queued in front of it. Asked for only once L3 had opened, it landed long
     * after the crossing that wanted it, and the ring unrolled onto an axis
     * with nothing on it.
     *
     * `visibleSecondsAt` clamps to `ENTRY_SECONDS` below L3, so standing in
     * the song asks for exactly the window L3 opens with: one request, made
     * while you are watching the measurement draw itself on, ready by the time
     * the axis has room for it.
     */
    if (
      !GRAIN_ENABLED ||
      (fieldCamera.level !== 'song' && fieldCamera.level !== 'grain') ||
      focused === null ||
      viewport === null
    ) {
      grainShared.value = null;
      return;
    }
    const ref = audioRefOf(focused);
    const onPhone =
      focused.localAudio.state === 'cached' ||
      focused.localAudio.state === 'pinned';
    if (ref === null || !onPhone) {
      grainShared.value = null;
      return;
    }

    const duration = focused.durationMs / 1000;
    const visible = visibleSecondsAt(
      fieldCamera.camera.scale,
      fieldCamera.renderFitScale,
    );
    const centre = transport.snapshot.positionSeconds;
    const window = grainWindow(centre, visible, duration);

    let active = true;
    void (async () => {
      try {
        const path =
          focused.source === 'device'
            ? focused.device.path
            : await commands.audioPath(
                focused.entity.nodePublicKey,
                focused.song,
                focused.delivery!,
              );
        const samples = await player.samples({
          ref,
          localPath: path,
          startSeconds: window.startSeconds,
          endSeconds: window.endSeconds,
          buckets: columnsFor(viewport.width),
        });
        if (!active) return;
        const rendered: GrainRender = {
          window: samples,
          label: `${window.visibleSeconds.toFixed(
            2,
          )}s VISIBLE · ${window.centerSeconds.toFixed(2)}s`,
        };
        grainShared.value = grainBarsOf(rendered);
      } catch (error) {
        if (active) {
          grainShared.value = null;
        }
        console.warn('grain window failed', readError(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [
    commands,
    fieldCamera.camera.scale,
    fieldCamera.level,
    fieldCamera.renderFitScale,
    focused,
    grainShared,
    player,
    transport.snapshot.positionSeconds,
    viewport,
  ]);

  const closeTopmostSheet = useCallback((): boolean => {
    // `sheetOpen`, not `sheetTarget`: the subject outlives the blind by the
    // length of its run, and a back press in that window belongs to whatever
    // is behind the sheet rather than to the sheet that is already leaving.
    if (sheetOpen) {
      setSheetOpen(false);
      return true;
    }
    if (pairing) {
      commands.hidePairing();
      return true;
    }
    if (composerOpen) {
      setComposerOpen(false);
      return true;
    }
    if (enginesOpen) {
      setEnginesOpen(false);
      return true;
    }
    return false;
  }, [commands, composerOpen, enginesOpen, pairing, sheetOpen]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (closeTopmostSheet()) return true;
        return fieldCamera.ascend();
      },
    );
    return () => subscription.remove();
  }, [closeTopmostSheet, fieldCamera]);

  const songCount = controller.presentations.size;
  /** The cluster you are inside, named the way its axis names it. */
  const focusedGroupLabel = useMemo(() => {
    const key = fieldCamera.groupKey;
    if (key === null || layout === null) return null;
    const group = layout.groups.find(candidate => candidate.key === key);
    return group === undefined ? null : shelfLabel(group.label, nowMs).primary;
  }, [fieldCamera.groupKey, layout, nowMs]);

  /**
   * What each node would take with it, if it were forgotten.
   *
   * Counted from the same read model the field is drawn from, so the warning
   * and the screen can never disagree about how many songs a node has here.
   */
  const footprints = useMemo(() => {
    const totals: Record<
      string,
      {
        songs: number;
        downloaded: number;
        bytesHere: number;
        borrowed: number;
        borrowedBytes: number;
        playlists: number;
      }
    > = {};
    const playlistsByNode: Record<string, Set<string>> = {};
    for (const presentation of controller.presentations.values()) {
      // Engines count what each node holds; a device song belongs to none.
      if (presentation.source !== 'node') continue;
      const key = presentation.entity.nodePublicKey;
      const entry = (totals[key] ??= {
        songs: 0,
        downloaded: 0,
        bytesHere: 0,
        borrowed: 0,
        borrowedBytes: 0,
        playlists: 0,
      });
      entry.songs += 1;
      // Pinned alone, because this count is what the forget screen promises
      // will still be here afterwards, and a cached copy is a loan the budget
      // may call in. Settings counts the two bands apart for the same reason.
      const bytes = presentation.delivery?.byte_length ?? 0;
      if (presentation.localAudio.state === 'pinned') {
        entry.downloaded += 1;
        entry.bytesHere += bytes;
      } else if (
        presentation.localAudio.state === 'cached' ||
        presentation.localAudio.state === 'partial'
      ) {
        entry.borrowed += 1;
        // A part-transfer holds only what has landed, which is what goes.
        entry.borrowedBytes +=
          presentation.localAudio.state === 'partial'
            ? presentation.localAudio.bytes
            : bytes;
      }
      const names = (playlistsByNode[key] ??= new Set<string>());
      for (const name of playlistsOf(presentation.entity.tags)) names.add(name);
    }
    for (const [key, names] of Object.entries(playlistsByNode)) {
      const entry = totals[key];
      if (entry !== undefined) entry.playlists = names.size;
    }
    return totals;
  }, [controller.presentations]);

  /** What settings counts: the library as placements, not only as songs. */
  const libraryReport = useMemo(() => {
    const playlists = new Set<string>();
    for (const presentation of controller.presentations.values()) {
      for (const name of playlistsOf(presentation.entity.tags)) {
        playlists.add(normalise([name])[0] ?? name);
      }
    }
    return {
      songs: controller.presentations.size,
      placements: layout?.placements.length ?? controller.presentations.size,
      playlists: playlists.size,
    };
  }, [controller.presentations, layout]);

  /** The two bands, counted apart because they promise different things. */
  const storageReport = useMemo(() => {
    let downloadedSongs = 0;
    let downloadedBytes = 0;
    let cachedSongs = 0;
    let cachedBytes = 0;
    for (const presentation of controller.presentations.values()) {
      // A device song's file is the person's own, not Cantor's storage.
      if (presentation.source !== 'node') continue;
      const bytes = presentation.delivery?.byte_length ?? 0;
      if (presentation.localAudio.state === 'pinned') {
        downloadedSongs += 1;
        downloadedBytes += bytes;
      } else if (presentation.localAudio.state === 'cached') {
        cachedSongs += 1;
        cachedBytes += bytes;
      }
    }
    return { downloadedSongs, downloadedBytes, cachedSongs, cachedBytes };
  }, [controller.presentations]);

  /** The cluster you are standing inside, at L1 and nowhere else. */
  const shelfGroup = useMemo(() => {
    if (fieldCamera.level !== 'shelf' || layout === null) return null;
    const groupKey = fieldCamera.groupKey;
    return layout.groups.find(candidate => candidate.key === groupKey) ?? null;
  }, [fieldCamera.groupKey, fieldCamera.level, layout]);

  /**
   * Measure the shelf you are standing in, in the background.
   *
   * So the song you open next has its sound already, rather than drawing it
   * in a few seconds after the descent. Only songs already on the phone, and
   * only this shelf: leaving it — for another shelf, the map, or a song, where
   * a decode would compete with playback — drops the rest of the list.
   */
  useEffect(() => {
    const refs =
      shelfGroup === null
        ? []
        : shelfGroup.entityKeys.flatMap(key => {
            const presentation = controller.presentations.get(key);
            const ref =
              presentation === undefined ? null : analysisRefOf(presentation);
            return ref === null ? [] : [ref];
          });
    analysisStore.prefetch(refs);
  }, [analysisStore, controller.presentations, shelfGroup]);

  /**
   * What `DOWNLOAD ALL` would fetch from the shelf you are standing in, and
   * what it weighs.
   *
   * The size is the point: downloads and the cache are different things, so
   * nothing here is measured against the cache budget and nothing is refused.
   * What a person is owed before asking for a whole shelf is the number.
   * Songs already downloaded are not counted — they are already yours.
   */
  const shelfDownload = useMemo(() => {
    if (shelfGroup === null) return null;
    const group = shelfGroup;
    const pending = group.entityKeys.flatMap(key => {
      const presentation = controller.presentations.get(key);
      return presentation === undefined ||
        presentation.source !== 'node' ||
        presentation.delivery === undefined ||
        presentation.localAudio.state === 'pinned'
        ? []
        : [presentation];
    });
    if (pending.length === 0) return null;
    const bytes = pending.reduce(
      (total, presentation) =>
        total + (presentation.delivery?.byte_length ?? 0),
      0,
    );
    return { pending, label: `DOWNLOAD ALL · ${formatBytes(bytes)}` };
  }, [controller.presentations, shelfGroup]);

  /** One at a time: the shelf shares one relay socket with everything else. */
  const downloadShelf = useCallback(() => {
    if (shelfDownload === null) return;
    void (async () => {
      for (const presentation of shelfDownload.pending) {
        await runRowAudio(presentation, 'GET');
      }
    })();
  }, [runRowAudio, shelfDownload]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setViewport({ width, height });
  }, []);
  const offline =
    backends !== null &&
    backends.length > 0 &&
    !backends.some(backend => phases[backend.nodePubkey] === 'ready');

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: pal.bg }]}>
      <View onLayout={onLayout} style={styles.field}>
        {layout !== null && viewport !== null ? (
          <GestureDetector gesture={fieldCamera.gesture}>
            <View collapsable={false} style={styles.field}>
              <LiveFieldCanvas
                controllerStore={controllerStore}
                cameraShared={fieldCamera.cameraShared}
                fitScaleShared={fieldCamera.fitScaleShared}
                layout={layout}
                labelFromGroups={fieldCamera.labelFromGroups}
                palette={pal}
                activeLensKey={lensKey}
                analyses={analyses}
                grainShared={grainShared}
                // The player's focus, not the tap's: entering a shelf must
                // not re-record this canvas. See `commitFocus`.
                focusKey={fieldCamera.playerFocus?.key ?? null}
                positionSeconds={canvasPosition}
                playingKey={playingKey}
                transportPlaying={transportPlaying}
                transportArriving={
                  focusedArrivingFraction === null ? null : transportArriving
                }
                transportLights={transportLights}
                nowMs={nowMs}
                transitionGeneration={fieldCamera.transitionGeneration}
                recut={fieldCamera.recut}
                presentations={controller.presentations}
                viewport={viewport}
              />
            </View>
          </GestureDetector>
        ) : null}
        {layout !== null ? (
          <>
            <FieldA11yList
              focus={fieldCamera.focus}
              layout={layout}
              level={fieldCamera.level}
              onSelect={fieldCamera.descend}
              placements={fieldCamera.renderedPlacements}
              presentations={controller.presentations}
            />
            <OriginMark
              camera={fieldCamera.camera}
              layout={layout}
              level={fieldCamera.level}
              onPress={fieldCamera.home}
            />
          </>
        ) : null}
        {(songAlpha > CAMERA_SUMMARY_KNOBS.SONG_MOUNT_ALPHA ||
          fieldCamera.playerFocus !== null) &&
        focused !== null &&
        viewport !== null ? (
          <View
            /*
             * Mounted on the commit that starts the descent, not when the band
             * opens. A tap into a song already waits for one commit before the
             * camera moves (see `descend`), so mounting here costs nothing the
             * flight can see; mounted at the band's edge instead, its native
             * views and gesture root landed mid-flight as one long frame, and
             * the player stopped and then appeared. It is invisible until the
             * band opens either way — its fade reads the live camera.
             *
             * Touchable only once it is mostly here: a transport at 4% opacity
             * is a control nobody can see and everybody can press.
             *
             * `songAlpha` decides *whether* — mounting, and whether a finger
             * lands — and nothing else. It cannot decide *how much*: it is
             * computed from React's copy of the camera, which lands a commit
             * late by design, so anything faded by it steps while the canvas
             * under it moves. That was the whole disconnection. What is left
             * here fades from `cameraShared` inside `SongSurface`; a commit of
             * lag on a touch target is invisible, and a commit of lag on a fade
             * is the seam.
             */
            pointerEvents={
              songAlpha > CAMERA_SUMMARY_KNOBS.SONG_TOUCH_ALPHA
                ? 'box-none'
                : 'none'
            }
            style={StyleSheet.absoluteFill}
          >
            <SongSurface
              available={focused.playable}
              cameraShared={fieldCamera.cameraShared}
              fitScale={fieldCamera.renderFitScale}
              height={viewport.height}
              isCurrent={focusedIsCurrent}
              lensKey={lensKey}
              lens={<LensPicker activeKey={lensKey} onChange={setLensKey} />}
              onOpenDetail={() => {
                setPlaybackError(null);
                setSheetOpen(true);
                setSheetTarget({
                  entityKey: focused.entity.key,
                  // The placement the words belong to, which is the same thing
                  // `focused` was read from.
                  groupKey: playerPlacement?.groupKey ?? null,
                });
              }}
              onSeek={focusedIsCurrent ? transport.scrub : () => {}}
              onSeekEnd={transport.finishScrub}
              onToggle={() => void playFocused()}
              steps={focusedSteps}
              onStep={stepFocused}
              afterSong={afterSong}
              onCycleAfterSong={cycleAfterSong}
              positionSeconds={focusedPosition}
              snapshot={
                playbackError === null
                  ? transport.snapshot
                  : { ...transport.snapshot, error: playbackError }
              }
              song={{
                key: focused.entity.key,
                id: focused.entity.entityId,
                title: focused.title,
                model: focused.recipe.model,
                seed: focused.recipe.seed,
                durationMs: focused.durationMs,
                nodeLabel: focused.label,
                audioState: focused.localAudio.state,
                // The word the touch layer announces has to mean what the drawn
                // verb means. The verb closes only for a live transfer, so the
                // word says `ARRIVING` only for a live transfer too — the arc
                // around the face is the one thing that speaks for bytes merely
                // sitting on disk.
                arriving: focusedArriving ? focusedArrivingFraction : null,
                tags: focused.entity.tags,
                imported: focused.source === 'device',
              }}
              width={viewport.width}
            />
          </View>
        ) : null}
        <FieldOverlay
          arrangementKey={arrangementKey}
          cameraShared={fieldCamera.cameraShared}
          fitScaleShared={fieldCamera.fitScaleShared}
          dateResolution={dateResolution}
          groupCount={layout?.groups.length ?? 0}
          groupLabel={focusedGroupLabel}
          level={fieldCamera.level}
          onChangeArrangement={setArrangementKey}
          onChangeDateResolution={setDateResolution}
          offline={offline}
          onOpenComposer={openComposer}
          onOpenEngines={openEnginesFromField}
          onChangeOrder={chooseOrder}
          onShelfAction={downloadShelf}
          orderKey={orderKey}
          shelfAction={shelfDownload?.label ?? null}
          songCount={shelfGroup?.entityKeys.length ?? songCount}
          storageError={audioError ?? storageError}
        />
      </View>

      {/*
        Neither sheet is a modal: each is a blind rolled against the edge it is
        pulled from, and it comes with the finger that pulls it. `pullShared` is
        where both of them are — one signed number, written by the field's own
        edge gesture on the UI thread — and `composerOpen`/`enginesOpen` decide
        only whether a blind ends up down or back up.
      */}
      {viewport !== null ? (
        <Curtain
          edge="top"
          onClose={closeComposer}
          open={composerOpen}
          destination={fieldCamera.pullDestinationShared}
          pull={fieldCamera.pullShared}
          title="NEW SONG"
          viewportHeight={viewport.height}
        >
          <ComposerSheet
            error={submitError}
            onClose={closeComposer}
            onSubmit={onComposerSubmit}
            submitting={submitting}
            targets={composerTargets}
          />
        </Curtain>
      ) : null}
      {viewport !== null ? (
        <Curtain
          edge="bottom"
          onClose={closeEngines}
          open={enginesOpen}
          destination={fieldCamera.pullDestinationShared}
          pull={fieldCamera.pullShared}
          title="ENGINES"
          viewportHeight={viewport.height}
        >
          <LiveEnginesSheet
            runtimeStore={runtime.store}
            backends={backends}
            open={enginesOpen}
            onClose={closeEngines}
            onPair={pairFromEngines}
            onRefresh={commands.refreshLibraries}
            refreshing={refreshing}
            budgetBytes={budgetBytes}
            footprints={footprints}
            library={libraryReport}
            onChangeBudget={changeBudget}
            publicKey={identity.publicKey}
            storage={storageReport}
            onForget={nodePublicKey => {
              setEnginesOpen(false);
              void forgetEngine(nodePublicKey);
            }}
            onRename={commands.renameBackend}
          />
        </Curtain>
      ) : null}
      <PairBackendModal
        onClose={commands.hidePairing}
        onPair={commands.pairBackend}
        visible={pairing}
      />
      {sheetSong !== null && sheetHeader !== null && viewport !== null ? (
        <Curtain
          edge="bottom"
          onClose={closeSongSheet}
          open={sheetOpen}
          openMs={SONG_SHEET_KNOBS.BLIND_MS}
          destination={sheetDestination}
          pull={sheetPull}
          title={sheetSong.title.toUpperCase()}
          viewportHeight={viewport.height}
        >
          <SongSheet
            audioState={sheetSong.localAudio.state}
            acting={songAct}
            detail={songDetail}
            detailError={songDetailError}
            problem={songProblem}
            deliveryBytes={
              sheetSong.source === 'node'
                ? sheetSong.delivery?.byte_length ?? null
                : null
            }
            imported={sheetImported}
            knownPlaylists={knownPlaylists}
            knownTags={knownTags}
            masterBytes={
              sheetSong.source === 'node' ? masterBytesOf(sheetSong.song) : null
            }
            nodeLabel={sheetSong.label}
            onClose={closeSongSheet}
            onDelete={() =>
              void runSongCommand('delete', async () => {
                // An imported song's sheet offers no delete: the file is the
                // person's own.
                if (sheetSong.source !== 'node') return;
                const track = transport.snapshot.track;
                if (
                  track?.nodeKey === sheetSong.entity.nodePublicKey &&
                  track?.songId === sheetSong.entity.entityId
                ) {
                  await transport.close();
                }
                // The copy here goes first. Trashing while a local file is still
                // on the phone orphans it: the song leaves the field, the sheet
                // becomes unreachable, and a pinned orphan is never reclaimed
                // because the budget only ever walks the cache tree.
                if (
                  sheetSong.delivery !== undefined &&
                  sheetSong.localAudio.state !== 'remote'
                ) {
                  if (sheetSong.localAudio.state === 'pinned') {
                    await commands.audio(
                      sheetSong.entity.nodePublicKey,
                      sheetSong.song,
                      sheetSong.delivery,
                      'unpin',
                    );
                  }
                  await commands.audio(
                    sheetSong.entity.nodePublicKey,
                    sheetSong.song,
                    sheetSong.delivery,
                    'remove',
                  );
                }
                await commands.changeSongPresence(
                  sheetSong.entity.nodePublicKey,
                  sheetSong.song,
                );
                setSheetOpen(false);
              })
            }
            onPatch={commitSheetPatch}
            onPin={() => runAudioAction('pin')}
            onRemoveDownload={() => runAudioAction('remove')}
            onUnpin={() => runAudioAction('unpin')}
            placementCount={sheetScope.placements}
            playlistProblem={playlistNameProblem}
            scopeLabel={sheetScope.label}
            song={sheetHeader}
            tagProblem={tagNameProblem}
            visible={sheetOpen}
          />
        </Curtain>
      ) : null}
      {pendingJob !== null && viewport !== null ? (
        <Curtain
          edge="bottom"
          onClose={closeJobSheet}
          open={jobOpen}
          openMs={JOB_SHEET_KNOBS.BLIND_MS}
          destination={jobDestination}
          pull={jobPull}
          title={(
            pendingJob.caption ?? jobStateLabel(pendingJob.job)
          ).toUpperCase()}
          viewportHeight={viewport.height}
        >
          <JobSheet
            busy={jobBusy}
            error={jobError}
            onClose={closeJobSheet}
            onControl={control => {
              setJobBusy(true);
              setJobError(null);
              void commands
                .controlJob(
                  pendingJob.entity.nodePublicKey,
                  pendingJob.job,
                  control,
                )
                .catch(problem => setJobError(readError(problem)))
                .finally(() => setJobBusy(false));
            }}
            onForget={() => {
              setJobBusy(true);
              setJobError(null);
              void commands
                .forgetJob(pendingJob.entity.nodePublicKey, pendingJob.job)
                // The sheet is about a job that no longer exists; there is
                // nothing left to show, so it leaves with it.
                .then(closeJobSheet)
                .catch(problem => setJobError(readError(problem)))
                .finally(() => setJobBusy(false));
            }}
            pending={pendingJob}
            visible={jobOpen}
          />
        </Curtain>
      ) : null}
      {condensing !== null && viewport !== null ? (
        <CondenseOverlay
          caption={condensing.caption}
          from={{
            x: space.lg,
            y: viewport.height * 0.24,
            width: viewport.width - space.lg * 2,
          }}
          onSettled={() => setCondensing(null)}
          to={condenseTarget}
        />
      ) : null}
      <PlayerHost onStep={skipFromLockScreen} player={player} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  field: { flex: 1 },
});
