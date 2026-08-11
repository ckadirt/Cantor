import {
  decodeArtifactInfo,
  decodeArtifactPart,
  decodeJobResponse,
  decodeLibraryChanges,
  decodeLibraryPage,
  isSafeRevision,
} from '../applicationResponses';

const artifact = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 10,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};

const song = {
  id: 'song-a',
  revision: 1,
  title: 'Song',
  caption_summary: 'Caption',
  created_at: '2026-08-09T00:00:00Z',
  duration_ms: 1_000,
  model: 'light',
  favorite: false,
  tags: [],
  trashed: false,
  artifacts: [artifact],
};

describe('application response decoders', () => {
  it('keeps strict artifact transfer limits and part variants', () => {
    expect(
      decodeArtifactInfo({
        transfer_id: 'transfer-a',
        song_id: 'song-a',
        artifact,
        accepted_offset: 0,
        chunk_bytes: 64 * 1024,
        window_chunks: 1,
      }),
    ).toMatchObject({
      transferId: 'transfer-a',
      songId: 'song-a',
      acceptedOffset: 0,
      chunkBytes: 64 * 1024,
      windowChunks: 1,
    });
    expect(
      decodeArtifactInfo({
        transfer_id: 'transfer-a',
        song_id: 'song-a',
        artifact,
        accepted_offset: 0,
        chunk_bytes: 64 * 1024 + 1,
        window_chunks: 1,
      }),
    ).toBeNull();
    expect(
      decodeArtifactPart({
        t: 'artifact.chunk',
        transfer_id: 'transfer-a',
        offset: 0,
        data: 'encoded',
      }),
    ).toEqual({
      kind: 'chunk',
      transferId: 'transfer-a',
      offset: 0,
      data: 'encoded',
    });
    expect(
      decodeArtifactPart({
        t: 'artifact.complete',
        transfer_id: 'transfer-a',
        byte_length: 10,
        sha256: artifact.sha256,
      }),
    ).toEqual({
      kind: 'complete',
      transferId: 'transfer-a',
      byteLength: 10,
      sha256: artifact.sha256,
    });
  });

  it('retains page cursor, tombstone, and incremental batch shapes', () => {
    expect(
      decodeLibraryPage({
        snapshot_revision: 4,
        songs: [song],
        tombstones: ['removed'],
        next_cursor: '',
      }),
    ).toEqual({
      snapshotRevision: 4,
      songs: [song],
      tombstones: ['removed'],
      nextCursor: '',
    });
    expect(
      decodeLibraryChanges({
        through_revision: 5,
        changes: [],
        has_more: true,
      }),
    ).toEqual({ changes: [], throughRevision: 5, hasMore: true });
    expect(
      decodeLibraryPage({
        snapshot_revision: -1,
        songs: [],
        tombstones: [],
      }),
    ).toBeNull();
  });

  it('uses canonical protocol decoders for domain values', () => {
    expect(decodeJobResponse({ job: { id: 'missing-fields' } })).toBeNull();
    expect(isSafeRevision(0)).toBe(true);
    expect(isSafeRevision(-1)).toBe(false);
    expect(isSafeRevision(1.5)).toBe(false);
  });
});
