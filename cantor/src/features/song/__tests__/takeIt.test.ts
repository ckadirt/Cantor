import { LENSES } from '../../../lenses/registry';
import type { TakeItSong } from '../../../export/service';
import type { ExportCopy } from '../../../export/types';
import {
  copyFolder,
  formatInForce,
  takeItWords,
  type TakeItState,
} from '../takeIt';

const DIGEST = 'a'.repeat(64);
const song: TakeItSong = {
  nodeKey: 'rtx',
  nodeLabel: 'agentbox',
  nodeReady: true,
  song: {
    id: '0b6f9c1e-6a3d-4c55-9a3e-2f4b8d7c1a90',
    revision: 1,
    title: 'Salt in the Lantern',
    caption_summary: '',
    created_at: '2026-11-08T00:00:00Z',
    duration_ms: 192_000,
    model: 'acestep@1.5-turbo',
    favorite: false,
    tags: [],
    trashed: false,
    artifacts: [],
  },
  delivery: {
    kind: 'delivery',
    profile: 'opus-stereo-160k-v1',
    media_type: 'audio/ogg',
    byte_length: 3_774_874,
    sha256: DIGEST,
    sample_rate: 48_000,
    channels: 2,
  },
  audioState: 'pinned',
  detail: null,
  lens: LENSES[0],
};

const copy: ExportCopy = {
  nodeKey: 'rtx',
  songId: song.song.id,
  format: 'opus',
  digest: DIGEST,
  mediaId: 41,
  path: '/storage/emulated/0/Music/Cantor/Salt in the Lantern.opus',
  uri: 'content://media/external_primary/audio/media/41',
  bytes: 3_880_000,
  savedAtMs: 1,
};

function words(overrides: Partial<TakeItState> = {}) {
  return takeItWords({
    song,
    format: 'opus',
    destination: { kind: 'music' },
    copies: [],
    acting: null,
    failure: null,
    ...overrides,
  });
}

describe('Take it’s words', () => {
  it('offers Opus with what it weighs', () => {
    expect(formatInForce('mp3')).toBe('mp3');
    expect(formatInForce('wav')).toBe('opus');
    expect(words()).toEqual({
      format: 'Opus',
      formatNote: '3.6 MB · THE ORIGINAL',
      share: 'Share',
      shareNote: 'THE FILE, NOT A LINK',
      shareReach: true,
      save: 'Save to Music',
      saveNote: 'INTO MUSIC/CANTOR',
      saveReach: true,
    });
  });

  it('weighs an MP3 at 320 kbps, and says it is being made', () => {
    // 192 s at 40 kB a second.
    expect(words({ format: 'mp3' })).toMatchObject({
      format: 'MP3',
      formatNote: '7.3 MB · PLAYS ANYWHERE',
    });
    expect(words({ format: 'mp3', acting: 'share' }).share).toBe('Making MP3');
    expect(words({ format: 'mp3', acting: 'save' }).save).toBe('Making MP3');
    const remote = { ...song, audioState: 'remote' as const };
    expect(words({ song: remote, format: 'mp3', acting: 'share' }).share).toBe(
      'Fetching',
    );
  });

  it('says an MP3 copy is saved only for MP3', () => {
    const mp3 = { ...copy, format: 'mp3' as const, bytes: 7_680_000 };
    expect(words({ format: 'mp3', copies: [copy, mp3] })).toMatchObject({
      save: 'In Music/Cantor',
      saveNote: 'SAVED · MP3 · 7.3 MB',
    });
    expect(words({ format: 'mp3', copies: [copy] }).save).toBe('Save to Music');
  });

  it('follows the folder chosen in Settings', () => {
    expect(words({ destination: { kind: 'download' } })).toMatchObject({
      save: 'Save to Download',
      saveNote: 'INTO DOWNLOAD/CANTOR',
    });
  });

  it('says where a saved copy is, and offers no second save', () => {
    expect(words({ copies: [copy] })).toMatchObject({
      save: 'In Music/Cantor',
      saveNote: 'SAVED · OPUS · 3.7 MB',
      saveReach: false,
      shareReach: true,
    });
    const elsewhere = { ...copy, path: '/storage/emulated/0/Download/Cantor/x.opus' };
    expect(words({ copies: [elsewhere] }).save).toBe('In Download/Cantor');
    expect(copyFolder({ ...copy, path: null, uri: 'content://media/external_primary/downloads/9' })).toBe(
      'Download/Cantor',
    );
  });

  it('offers to save again a copy made from other audio', () => {
    expect(words({ copies: [{ ...copy, digest: 'b'.repeat(64) }] })).toMatchObject({
      save: 'Save to Music',
      saveReach: true,
    });
  });

  it('turns each act to its present tense while it works', () => {
    expect(words({ acting: 'share' })).toMatchObject({
      share: 'Copying',
      shareReach: true,
      saveReach: false,
    });
    expect(words({ acting: 'save' })).toMatchObject({
      save: 'Saving',
      saveReach: true,
      shareReach: false,
    });
    const remote = { ...song, audioState: 'remote' as const };
    expect(words({ song: remote, acting: 'share' }).share).toBe('Fetching');
    expect(words({ song: remote }).formatNote).toBe('3.6 MB TO FETCH');
  });

  it('says why nothing can be taken', () => {
    const away = { ...song, audioState: 'remote' as const, nodeReady: false };
    expect(words({ song: away })).toMatchObject({
      formatNote: 'AGENTBOX IS AWAY',
      shareReach: false,
      saveReach: false,
    });
    expect(words({ song: { ...song, delivery: null } }).formatNote).toBe('NO AUDIO YET');
  });

  it('says which act failed, and why when it knows', () => {
    expect(words({ failure: { act: 'share', code: 'failed' } }).shareNote).toBe(
      'COULD NOT SHARE',
    );
    expect(words({ failure: { act: 'save', code: 'permission' } }).saveNote).toBe(
      'NOT ALLOWED TO SAVE',
    );
    expect(words({ failure: { act: 'save', code: 'failed' } }).saveNote).toBe(
      'COULD NOT SAVE',
    );
  });
});
