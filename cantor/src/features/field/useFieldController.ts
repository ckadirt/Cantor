import { audioKey } from '../../audio/repository';
import type { LocalAudio } from '../../audio/native';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongHeader } from '../../core/protocol';
import type { BackendRecord } from '../../backends/types';
import { deliveryArtifact, type BackendRuntimeState } from '../../runtime';
import type { FieldEntity } from '../../field';

export type FieldPresentation = Readonly<{
  entity: FieldEntity;
  song: SongHeader;
  backend: BackendRecord;
  ready: boolean;
  nodeLabels: readonly string[];
  delivery: ArtifactView | undefined;
  localAudio: LocalAudio;
}>;

export type FieldController = Readonly<{
  entities: readonly FieldEntity[];
  presentations: ReadonlyMap<string, FieldPresentation>;
}>;

type FieldRuntimeState = Pick<
  BackendRuntimeState,
  'backends' | 'snapshots' | 'localAudio'
>;

const REMOTE_AUDIO: LocalAudio = { state: 'remote', bytes: 0 };

/**
 * Project runtime truth into the tiny read model used by the field. The field
 * deliberately does not own a backend connection or inspect persisted data.
 */
export function buildFieldController(
  state: FieldRuntimeState,
): FieldController {
  const presentations = new Map<string, FieldPresentation>();
  for (const backend of state.backends ?? []) {
    const snapshot = state.snapshots[backend.nodePubkey];
    for (const song of snapshot?.songs ?? []) {
      if (song.trashed) continue;
      const delivery = deliveryArtifact(song);
      const entity: FieldEntity = {
        key: `${backend.nodePubkey}:${song.id}`,
        nodePublicKey: backend.nodePubkey,
        entityId: song.id,
        kind: 'song',
        createdAtMs: timestampOrEpoch(song.created_at),
        tags: song.tags,
      };
      presentations.set(entity.key, {
        entity,
        song,
        backend,
        ready: snapshot?.phase === 'ready',
        nodeLabels: [
          backend.petname,
          backend.lastNodeInfo?.name ?? '',
          backend.nodePubkey,
        ].filter(Boolean),
        delivery,
        localAudio:
          state.localAudio[
            audioKey(backend.nodePubkey, song.id, delivery?.sha256 ?? 'none')
          ] ?? REMOTE_AUDIO,
      });
    }
  }
  const ordered = [...presentations.values()].sort(
    (left, right) =>
      right.entity.createdAtMs - left.entity.createdAtMs ||
      left.entity.key.localeCompare(right.entity.key),
  );
  return {
    entities: ordered.map(presentation => presentation.entity),
    presentations,
  };
}

function timestampOrEpoch(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
