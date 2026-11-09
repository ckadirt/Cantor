import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import { DEVICE_MIGRATIONS } from '../../device/schema';
import { LENSES } from '../../lenses/registry';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongHeader } from '../../../../protocol/SongHeader';
import { createExportCopyRepository } from '../copies';
import { readMarker, nodeTagOf } from '../marker';
import type { ExportPort } from '../native';
import {
  blockOf,
  createExportService,
  exportTags,
  fileNameOf,
  type TakeItSong,
} from '../service';

const DIGEST = 'a'.repeat(64);
const delivery: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg',
  byte_length: 3_600_000,
  sha256: DIGEST,
  sample_rate: 48_000,
  channels: 2,
};
const MASTER = 'f'.repeat(64);
const master: ArtifactView = {
  kind: 'master',
  profile: 'pcm16-wav-v1',
  media_type: 'audio/wav',
  byte_length: 34_000_000,
  sha256: MASTER,
  sample_rate: 48_000,
  channels: 2,
};
const header: SongHeader = {
  id: '0b6f9c1e-6a3d-4c55-9a3e-2f4b8d7c1a90',
  revision: 1,
  title: 'Salt in the Lantern',
  caption_summary: 'a slow harbour',
  created_at: '2026-11-08T00:00:00Z',
  duration_ms: 192_000,
  model: 'acestep@1.5-turbo',
  seed: 7,
  favorite: false,
  tags: [],
  trashed: false,
  artifacts: [delivery],
};

function song(overrides: Partial<TakeItSong> = {}): TakeItSong {
  return {
    nodeKey: 'rtx',
    nodeLabel: 'agentbox',
    nodeReady: true,
    song: header,
    delivery,
    master,
    masterTransfer: true,
    audioState: 'pinned',
    detail: {
      song: header,
      generation: { caption: 'a slow harbour', lyrics: 'lanterns on the water' },
      engine: 'acestep',
      component_digests: [],
      attempts: 1,
    },
    lens: LENSES[0],
    ...overrides,
  };
}

function fakeNative() {
  /** Parts on disk by key, and WAVs staged by key. */
  const parts = new Map<string, number>();
  const wavs = new Map<string, string>();
  const files = new Set<string>();
  let next = 40;
  const native = {
    staged: [] as Parameters<ExportPort['stageOpus']>[0][],
    shared: [] as string[],
    saved: [] as { path: string; destination: string; replace: string | null }[],
    files,
    stageOpus: jest.fn(async (request: Parameters<ExportPort['stageOpus']>[0]) => {
      native.staged.push(request);
      return { path: `/cache/exports/${request.key}/${request.name}`, bytes: 3_700_000 };
    }),
    stageMp3: jest.fn(async (request: Parameters<ExportPort['stageMp3']>[0]) => {
      native.staged.push(request);
      return {
        path: `/cache/exports/${request.key}/${request.name}`,
        bytes: 7_700_000,
        encodeMs: 1_500,
        segments: 4,
      };
    }),
    share: jest.fn(async (path: string) => {
      native.shared.push(path);
    }),
    save: jest.fn(
      async (path: string, _mime: string, destination: 'music' | 'download', replace: string | null) => {
        native.saved.push({ path, destination, replace });
        if (replace !== null && files.has(replace)) {
          return { uri: replace, mediaId: 1, path: '/Music/Cantor/x.opus' };
        }
        next += 1;
        const uri = `content://media/external_primary/audio/media/${next}`;
        files.add(uri);
        return { uri, mediaId: next, path: `/storage/emulated/0/Music/Cantor/${next}.opus` };
      },
    ),
    present: jest.fn(async (uris: readonly string[]) => uris.map(uri => files.has(uri))),
    prune: jest.fn(async () => 0),
    canWrite: jest.fn(async () => true),
    parts,
    wavs,
    masterPart: jest.fn(async (key: string, _name: string) => {
      const staged = wavs.get(key);
      return {
        path: `/cache/exports/${key}/.master.part`,
        bytes: parts.get(key) ?? 0,
        staged: staged === undefined ? null : { path: staged, bytes: 34_000_400 },
      };
    }),
    stageWav: jest.fn(
      async (part: string, digest: string, request: { key: string; name: string; comments: unknown }) => {
        native.staged.push({ ...request, source: part, cover: null } as never);
        const path = `/cache/exports/${request.key}/${request.name}`;
        wavs.set(request.key, path);
        return { path, bytes: 34_000_400 };
      },
    ),
  };
  return native;
}

async function setup() {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  const repository = createExportCopyRepository(db);
  const native = fakeNative();
  const fetchAudio = jest.fn(async () => {});
  const fetchFile = jest.fn(
    async (
      _node: string,
      _song: SongHeader,
      _artifact: ArtifactView,
      _path: string,
      offset: () => Promise<number>,
      onProgress?: (written: number, total: number) => void,
    ) => {
      const from = await offset();
      onProgress?.(from, 100);
      onProgress?.(100, 100);
    },
  );
  const service = createExportService({
    native,
    repository: async () => repository,
    fetchAudio,
    fetchFile,
    audioPath: async () => '/data/pinned/song.opus',
    renderCover: () => ({ png: 'iVBORw0KGgo', width: 1000, height: 1000 }),
    now: () => 9_000,
  });
  return { service, native, repository, fetchAudio, fetchFile };
}

describe('names and tags', () => {
  it('names a file after its song, minus what file systems refuse', () => {
    expect(fileNameOf('Salt in the Lantern', 'opus')).toBe('Salt in the Lantern.opus');
    expect(fileNameOf('AC/DC: "live"?', 'mp3')).toBe('AC DC live.mp3');
    expect(fileNameOf('...hidden', 'opus')).toBe('hidden.opus');
    expect(fileNameOf('  \u0007 ', 'opus')).toBe('Cantor song.opus');
    expect(fileNameOf('x'.repeat(400), 'opus')).toHaveLength(120 + '.opus'.length);
  });

  it('carries the marker first, then what a player shows', () => {
    const tags = exportTags(song(), DIGEST);
    expect(tags.map(([key]) => key)).toEqual(['CANTOR', 'TITLE', 'ALBUM', 'LYRICS', 'DESCRIPTION']);
    expect(readMarker(tags[0][1])).toEqual({
      nodeTag: nodeTagOf('rtx'),
      songId: header.id,
      digest: DIGEST,
    });
    expect(exportTags(song({ detail: null }), DIGEST).map(([key]) => key)).toEqual([
      'CANTOR',
      'TITLE',
      'ALBUM',
    ]);
  });

  it('is blocked only when the audio cannot be reached', () => {
    expect(blockOf(song())).toBeNull();
    expect(blockOf(song({ audioState: 'remote' }))).toBeNull();
    expect(blockOf(song({ audioState: 'remote', nodeReady: false }))).toBe('away');
    expect(blockOf(song({ audioState: 'cached', nodeReady: false }))).toBeNull();
    expect(blockOf(song({ delivery: null }))).toBe('no-audio');
  });
});

describe('the export service', () => {
  it('shares the song as a staged, tagged file with its face', async () => {
    const { service, native, fetchAudio } = await setup();
    await service.share(song(), 'opus');
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(native.staged).toHaveLength(1);
    expect(native.staged[0]).toMatchObject({
      source: '/data/pinned/song.opus',
      name: 'Salt in the Lantern.opus',
      cover: { width: 1000 },
    });
    expect(native.shared).toEqual([native.staged[0] && `/cache/exports/${native.staged[0].key}/Salt in the Lantern.opus`]);
    expect(native.share).toHaveBeenCalledWith(expect.any(String), 'audio/ogg');
  });

  it('makes an MP3 with the same tags, and shares it as one', async () => {
    const { service, native } = await setup();
    await service.share(song(), 'mp3');
    expect(native.stageMp3).toHaveBeenCalledTimes(1);
    expect(native.stageOpus).not.toHaveBeenCalled();
    const [request] = native.staged;
    expect(request.name).toBe('Salt in the Lantern.mp3');
    expect(request.key.startsWith('mp3-')).toBe(true);
    expect(request.comments).toEqual(exportTags(song(), DIGEST));
    expect(native.share).toHaveBeenCalledWith(request && `/cache/exports/${request.key}/Salt in the Lantern.mp3`, 'audio/mpeg');
  });

  it('keeps an MP3 copy beside an Opus one', async () => {
    const { service } = await setup();
    await service.save(song(), 'opus', { kind: 'music' });
    const mp3 = await service.save(song(), 'mp3', { kind: 'music' });
    expect(mp3).toMatchObject({ format: 'mp3', bytes: 7_700_000 });
    expect((await service.copies('rtx', header.id)).map(copy => copy.format)).toEqual([
      'opus',
      'mp3',
    ]);
  });

  it('refuses a format this build does not make', async () => {
    const { service, native } = await setup();
    await expect(service.share(song(), 'flac' as never)).rejects.toMatchObject({ code: 'failed' });
    expect(native.staged).toEqual([]);
  });

  it('fetches the master into the export cache and stages it as WAV', async () => {
    const { service, native, fetchFile } = await setup();
    const progress: number[] = [];
    await service.share(song(), 'wav', fraction => progress.push(fraction));
    expect(fetchFile).toHaveBeenCalledTimes(1);
    const [node, , artifact, path] = fetchFile.mock.calls[0];
    expect(node).toBe('rtx');
    expect(artifact).toBe(master);
    expect(path).toMatch(/^\/cache\/exports\/wav-[0-9a-f]+\/\.master\.part$/);
    expect(native.stageWav).toHaveBeenCalledWith(path, MASTER, expect.objectContaining({
      name: 'Salt in the Lantern.wav',
    }));
    // The marker names the master's digest, not the delivery's.
    const comments = native.stageWav.mock.calls[0][2].comments as [string, string][];
    expect(readMarker(comments[0][1])?.digest).toBe(MASTER);
    expect(progress).toEqual([0, 1]);
    expect(native.share).toHaveBeenCalledWith(expect.stringMatching(/\.wav$/), 'audio/wav');
    expect(native.stageOpus).not.toHaveBeenCalled();
  });

  it('does not fetch the master again once it is staged', async () => {
    const { service, fetchFile } = await setup();
    await service.share(song(), 'wav');
    await service.share(song(), 'wav');
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('saves a WAV copy matched by the master’s digest', async () => {
    const { service, native } = await setup();
    const copy = await service.save(song(), 'wav', { kind: 'music' });
    expect(copy).toMatchObject({ format: 'wav', digest: MASTER });
    expect(await service.save(song(), 'wav', { kind: 'music' })).toEqual(copy);
    expect(native.save).toHaveBeenCalledTimes(1);
  });

  it('says why a WAV cannot be had, and fetches nothing', async () => {
    const { service, fetchFile } = await setup();
    await expect(service.share(song({ nodeReady: false }), 'wav')).rejects.toMatchObject({
      code: 'away',
    });
    await expect(service.share(song({ masterTransfer: false }), 'wav')).rejects.toMatchObject({
      code: 'old-node',
    });
    await expect(service.share(song({ master: null }), 'wav')).rejects.toMatchObject({
      code: 'no-audio',
    });
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('fetches a song that is not on the phone first', async () => {
    const { service, fetchAudio } = await setup();
    await service.share(song({ audioState: 'remote' }), 'opus');
    expect(fetchAudio).toHaveBeenCalledWith('rtx', header, delivery);
  });

  it('refuses honestly when the node is away and the audio is not here', async () => {
    const { service, native } = await setup();
    await expect(
      service.share(song({ audioState: 'remote', nodeReady: false }), 'opus'),
    ).rejects.toMatchObject({ code: 'away' });
    expect(native.staged).toEqual([]);
  });

  it('keys a staged file by what is in it', async () => {
    const { service, native } = await setup();
    await service.share(song(), 'opus');
    await service.share(song(), 'opus');
    await service.share(song({ lens: LENSES[1] }), 'opus');
    const [a, b, c] = native.staged.map(request => request.key);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('saves once, remembers the copy, and does nothing the second time', async () => {
    const { service, native, repository } = await setup();
    const copy = await service.save(song(), 'opus', { kind: 'music' });
    expect(copy).toMatchObject({ nodeKey: 'rtx', format: 'opus', digest: DIGEST, savedAtMs: 9_000 });
    expect(await repository.forSong('rtx', header.id)).toEqual([copy]);
    expect(await service.save(song(), 'opus', { kind: 'music' })).toEqual(copy);
    expect(native.save).toHaveBeenCalledTimes(1);
    expect(native.saved[0]).toMatchObject({ destination: 'music', replace: null });
  });

  it('replaces a copy made from older audio in place', async () => {
    const { service, native } = await setup();
    const first = await service.save(song(), 'opus', { kind: 'download' });
    const newer = { ...delivery, sha256: 'b'.repeat(64) };
    const second = await service.save(song({ delivery: newer }), 'opus', { kind: 'download' });
    expect(native.saved[1]).toMatchObject({ destination: 'download', replace: first.uri });
    expect(second.digest).toBe('b'.repeat(64));
  });

  it('forgets a copy deleted outside Cantor, and saves it again', async () => {
    const { service, native } = await setup();
    const first = await service.save(song(), 'opus', { kind: 'music' });
    native.files.delete(first.uri);
    expect(await service.copies('rtx', header.id)).toEqual([]);
    const again = await service.save(song(), 'opus', { kind: 'music' });
    expect(again.uri).not.toBe(first.uri);
    expect(await service.copies('rtx', header.id)).toEqual([again]);
  });

  it('says so when Android will not let it write', async () => {
    const { service, native } = await setup();
    native.canWrite.mockResolvedValueOnce(false);
    await expect(service.save(song(), 'opus', { kind: 'music' })).rejects.toMatchObject({
      code: 'permission',
    });
    expect(native.staged).toEqual([]);
  });

  it('keeps nothing of a deleted song but the files themselves', async () => {
    const { service, native } = await setup();
    await service.save(song(), 'opus', { kind: 'music' });
    await service.forgetSong('rtx', header.id);
    expect(await service.copies('rtx', header.id)).toEqual([]);
    expect(native.files.size).toBe(1);
  });
});
