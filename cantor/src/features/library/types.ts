import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongDetail } from '../../../../protocol/SongDetail';
import type { SongHeader } from '../../../../protocol/SongHeader';
import type { SongPatch } from '../../../../protocol/SongPatch';
import type { LocalAudio } from '../../audio/native';
import type { BackendRecord } from '../../backends/types';

export type AudioAction = 'download-play' | 'play' | 'pin' | 'unpin' | 'remove';

export type LibraryRow = {
  backend: BackendRecord;
  song: SongHeader;
  delivery: ArtifactView | undefined;
  local: LocalAudio;
  availableOffline: boolean;
  ready: boolean;
  nodeLabels: string[];
};

export type LibraryTimelineProps = {
  rows: LibraryRow[];
  onDetail: (nodePublicKey: string, songId: string) => Promise<SongDetail>;
  onPatch: (
    nodePublicKey: string,
    song: SongHeader,
    patch: SongPatch,
  ) => Promise<void>;
  onPresence: (nodePublicKey: string, song: SongHeader) => Promise<void>;
  onAudio: (
    nodePublicKey: string,
    song: SongHeader,
    artifact: ArtifactView,
    action: AudioAction,
  ) => Promise<void>;
  onError: (error: unknown) => void;
};

export type LibrarySongRowProps = {
  row: LibraryRow;
  onDetail: LibraryTimelineProps['onDetail'];
  onPatch: LibraryTimelineProps['onPatch'];
  onPresence: LibraryTimelineProps['onPresence'];
  onAudio: LibraryTimelineProps['onAudio'];
  onError: LibraryTimelineProps['onError'];
};
