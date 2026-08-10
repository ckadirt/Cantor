import type { JobView, NodeInfo, SongHeader } from '../core/protocol';
import type { TransportDescriptor } from '../security/types';

/**
 * Compatibility façade for the original backend API.
 *
 * New protocol and security code should import from `core/protocol`,
 * `core/validation`, and `security/types` directly. Existing consumers keep the
 * same exports while they migrate feature by feature.
 */
export {
  APPLICATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  parseArtifact,
  parseJob,
  parseJobs,
  parseLibraryChanges,
  parseNodeInfo,
  parseSong,
  parseSongDetail,
  parseSongs,
} from '../core/protocol';
export type {
  ErrorCode,
  JobView,
  LibraryChange,
  NodeInfo,
  SongDetail,
  SongHeader,
} from '../core/protocol';
export { isRecord } from '../core/validation';
export type { TransportDescriptor } from '../security/types';

export type BackendRecord = {
  nodePubkey: string;
  relayUrl: string;
  petname: string;
  lastNodeInfo: NodeInfo | null;
  /** Set only after the descriptor signature and a Noise handshake succeed. */
  transport?: TransportDescriptor;
};

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'attached'
  | 'handshaking'
  | 'ready';

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error: string | null;
  jobs: JobView[];
  songs: SongHeader[];
  libraryRevision: number | null;
  librarySyncing: boolean;
};

export type PairingRequest = { backend: BackendRecord; pairToken: string };
