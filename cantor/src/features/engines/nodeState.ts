import type { ModelView } from '../../../../protocol/ModelView';
import type { JobState } from '../../../../protocol/JobState';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';

/**
 * A node's state, written the way a person would say it (`nodes.html#roster`).
 * The connection's own phases (`attached`, `handshaking`) never reach the
 * screen: `connecting` and `handshaking` are still *connecting* to the person
 * waiting, and `attached` (the relay answers, the node does not) is offline.
 */
export type NodeState = 'ready' | 'working' | 'connecting' | 'offline';

/** The job states in which a node is making something right now. */
const MAKING: ReadonlySet<JobState> = new Set<JobState>([
  'queued',
  'preparing',
  'running',
  'recovering',
  'finalizing',
]);

/** How many songs a node is making for this phone right now. */
export function songsInTheMaking(
  snapshot: ConnectionSnapshot | undefined,
): number {
  if (snapshot === undefined) return 0;
  return snapshot.jobs.filter(job => MAKING.has(job.state)).length;
}

export function nodeState(snapshot: ConnectionSnapshot | undefined): NodeState {
  // `attached` is the relay reached and the node not there: the relay says so
  // with `relay.presence` offline or a `node-offline` error. To a person that
  // is a node that is offline, not one still connecting.
  if (
    snapshot === undefined ||
    snapshot.phase === 'disconnected' ||
    snapshot.phase === 'attached'
  )
    return 'offline';
  if (snapshot.phase !== 'ready') return 'connecting';
  return songsInTheMaking(snapshot) > 0 ? 'working' : 'ready';
}

/**
 * A node's state from its connection phase alone, for a surface that names a
 * node without holding its snapshot (the song's record): it cannot see jobs,
 * so it never says `working`.
 */
export function nodeStateOfPhase(phase: string | undefined): NodeState {
  if (phase === 'ready') return 'ready';
  if (phase === 'connecting' || phase === 'handshaking') return 'connecting';
  return 'offline';
}

/**
 * The state as a word. `OFFLINE` alone: the app does not record when a node
 * was last ready yet, so `OFFLINE SINCE 14:02` waits for that (folio-log.md).
 */
export function nodeStateWord(
  snapshot: ConnectionSnapshot | undefined,
): string {
  switch (nodeState(snapshot)) {
    case 'ready':
      return 'READY';
    case 'working': {
      const making = songsInTheMaking(snapshot);
      return making === 1 ? 'MAKING A SONG' : `MAKING ${making} SONGS`;
    }
    case 'connecting':
      return 'CONNECTING';
    default:
      return 'OFFLINE';
  }
}

/** Every model seen on a paired node, and the names of the nodes it is on. */
export type KnownModel = Readonly<{
  model: ModelView;
  /** The nodes reporting it, by public key, in pairing order. */
  on: readonly string[];
}>;

/**
 * The join the nodes panel has always made across paired nodes, now keeping
 * which node each model was seen on, so a model missing here can say where it
 * is (`ON H100`). These are models observed on paired nodes, not a catalogue.
 */
export function knownModels(
  backends: readonly BackendRecord[] | null,
): ReadonlyMap<string, KnownModel> {
  const seen = new Map<string, { model: ModelView; on: string[] }>();
  for (const backend of backends ?? []) {
    for (const model of backend.lastNodeInfo?.models ?? []) {
      const entry = seen.get(model.selector);
      if (entry === undefined)
        seen.set(model.selector, { model, on: [backend.nodePubkey] });
      else entry.on.push(backend.nodePubkey);
    }
  }
  return seen;
}

/** `1.5 · fast`: a selector without its family, its parts spaced. */
export function variantLabel(model: ModelView): string {
  const prefix = `${model.family}:`;
  const rest = model.selector.startsWith(prefix)
    ? model.selector.slice(prefix.length)
    : model.selector;
  return rest.split('-').join(' · ');
}
