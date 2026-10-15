import type { ModelView } from '../../../../../protocol/ModelView';
import type { NodeLimits } from '../../../../../protocol/NodeLimits';
import {
  draftFromSource,
  modelsFor,
  problemsWith,
  toGenerationRequest,
  voiceOf,
  type SongSource,
  type ComposerTarget,
} from '../draft';

const limits: NodeLimits = {
  max_concurrent_jobs: 1,
  max_queued_jobs_per_principal: 4,
  min_song_seconds: 15,
  max_song_seconds: 600,
  max_caption_bytes: 1024,
  max_lyrics_bytes: 65536,
  max_page_limit: 100,
};

const audioModel: ModelView = {
  selector: 'acestep:1.5-fast',
  family: 'acestep',
  engine: 'acestep',
  capabilities: [
    { kind: 'cover', stages: ['diffuse', 'decode'] },
    { kind: 'extend', max_total_seconds: 300 },
    { kind: 'timbre' },
  ],
};
const textOnly: ModelView = {
  selector: 'levo2:x',
  family: 'levo2',
  engine: 'levo2',
  capabilities: [],
};

function target(overrides: Partial<ComposerTarget> = {}): ComposerTarget {
  return {
    nodePublicKey: 'node-a',
    label: 'agentbox',
    ready: true,
    models: [audioModel, textOnly],
    limits,
    takesAudio: true,
    takesUploads: true,
    ...overrides,
  };
}

const song: SongSource = {
  kind: 'song',
  act: 'version',
  songId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  nodePublicKey: 'node-a',
  title: 'Harbour at dusk',
  durationMs: 192_000,
  prompt: 'a slow harbour at dusk',
  words: 'the tide comes in',
  model: 'acestep:1.5-fast',
};

function versionDraft(patch = {}) {
  return {
    ...draftFromSource(song),
    modelSelector: 'acestep:1.5-fast',
    ...patch,
  };
}

describe('a draft that starts from a song', () => {
  it('opens on the song, its prompt and its words', () => {
    const draft = draftFromSource(song);
    expect(draft).toMatchObject({
      caption: 'a slow harbour at dusk',
      nodePublicKey: 'node-a',
      wordsMode: 'same',
      follow: 0.5,
    });
    expect(draftFromSource({ ...song, words: null }).wordsMode).toBe('none');
  });

  it('offers only models that declare the act, and none on a node without audio', () => {
    expect(modelsFor(target(), 'version').map(m => m.selector)).toEqual([
      'acestep:1.5-fast',
    ]);
    expect(modelsFor(target({ takesAudio: false }), 'version')).toEqual([]);
    expect(modelsFor(target(), null)).toHaveLength(2);
  });

  it('keeps the voice while the caption is the song’s own, and lets the person decide', () => {
    expect(voiceOf(versionDraft(), audioModel)).toBe('keep');
    expect(
      voiceOf(versionDraft({ caption: 'sung by a woman' }), audioModel),
    ).toBe('new');
    expect(
      voiceOf(
        versionDraft({ caption: 'sung by a woman', voice: 'keep' }),
        audioModel,
      ),
    ).toBe('keep');
    const noTimbre = {
      ...audioModel,
      capabilities: [{ kind: 'cover' as const }],
    };
    expect(voiceOf(versionDraft(), noTimbre)).toBeNull();
  });

  it('sends a version as a cover of the song, with its words and no length', () => {
    const request = toGenerationRequest(
      versionDraft({ follow: 0, durationSeconds: 60 }),
      [],
      audioModel,
    );
    expect(request).toEqual({
      caption: 'a slow harbour at dusk',
      lyrics: 'the tide comes in',
      audio: {
        source: { kind: 'song', song_id: song.songId },
        act: 'cover',
        closeness: 0,
        keep_voice: true,
      },
    });
    const changed = toGenerationRequest(
      versionDraft({ caption: 'jazz trio', wordsMode: 'none' }),
      [],
      audioModel,
    );
    expect(changed.audio).not.toHaveProperty('keep_voice');
  });

  it('sends a longer song as an extension, bounded by what the model makes', () => {
    const longer = {
      ...draftFromSource({ ...song, act: 'longer' }),
      modelSelector: 'acestep:1.5-fast',
    };
    expect(
      toGenerationRequest(
        { ...longer, extendSeconds: 60, extendAt: 'start' },
        [],
        audioModel,
      ).audio,
    ).toEqual({
      source: { kind: 'song', song_id: song.songId },
      act: 'extend',
      extend_seconds: 60,
      extend_at: 'start',
    });
    expect(problemsWith({ ...longer, extendSeconds: 90 }, [target()])).toEqual(
      [],
    );
    // 192 s + 120 s passes the model's 300 s total.
    expect(
      problemsWith({ ...longer, extendSeconds: 120 }, [target()]),
    ).toContainEqual({
      kind: 'too-long-to-extend',
      max: 108,
    });
  });

  it('refuses a version made somewhere the song is not, or by a model that cannot', () => {
    const elsewhere = target({ nodePublicKey: 'node-b', label: 'h100' });
    expect(
      problemsWith({ ...versionDraft(), nodePublicKey: 'node-b' }, [
        target(),
        elsewhere,
      ]),
    ).toContainEqual({
      kind: 'source-elsewhere',
      label: 'h100',
    });
    expect(
      problemsWith(versionDraft({ modelSelector: 'levo2:x' }), [target()]),
    ).toContainEqual({
      kind: 'model-cannot',
      act: 'version',
    });
    expect(problemsWith(versionDraft(), [target()])).toEqual([]);
  });
});
