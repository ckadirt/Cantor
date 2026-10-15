import { parseNodeInfo } from '../protocol';
import {
  doorAcross,
  doorFor,
  mediaTypeOfPath,
  installCommand,
  modelsFor,
  stagesFor,
  suggestionFor,
  voiceOffered,
} from '../audioActs';

const capabilities = require('../../../../protocol/fixtures/v2/node-info-capabilities.json');
const lyricsNode = require('../../../../protocol/fixtures/v2/node-info-lyrics.json');

function node(patch: Record<string, unknown> = {}) {
  const parsed = parseNodeInfo({ ...capabilities.node, ...patch });
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
}

describe('audio acts from declared capabilities', () => {
  it('offers each act only on the models that declare what it needs', () => {
    const info = node();
    expect(modelsFor(info, 'version').map(m => m.selector)).toEqual([
      'acestep:1.5-fast',
    ]);
    expect(modelsFor(info, 'longer').map(m => m.selector)).toEqual([
      'acestep:1.5-fast',
    ]);
    expect(voiceOffered(info.models[0])).toBe(true);
    expect(stagesFor(info.models[0], 'version')).toEqual(['diffuse', 'decode']);
  });

  it('offers nothing on a node that predates audio, and does not suggest installs there', () => {
    const old = parseNodeInfo(lyricsNode.node);
    if (!old) throw new Error('fixture');
    expect(modelsFor(old, 'version')).toEqual([]);
    expect(doorFor(old, 'version')).toEqual({ kind: 'unsupported' });
  });

  it('a tune needs uploads as well as audio sources', () => {
    const info = node({
      features: { ...capabilities.node.features, uploads: false },
    });
    expect(modelsFor(info, 'hum', true)).toEqual([]);
    expect(modelsFor(info, 'version', false)).toHaveLength(1);
  });

  it('turns a shut door into the smallest model that would open it', () => {
    const info = node({
      models: [capabilities.node.models[1]],
      installable: [
        {
          selector: 'acestep:1.5-quality',
          family: 'acestep',
          capabilities: ['cover', 'extend'],
          bytes: 9e9,
          licence: '',
        },
        {
          selector: 'acestep:1.5-fast',
          family: 'acestep',
          capabilities: ['cover', 'extend'],
          bytes: 4.5e9,
          licence: '',
        },
        {
          selector: 'levo2:x',
          family: 'levo2',
          capabilities: [],
          bytes: 1e9,
          licence: '',
        },
      ],
    });
    const door = doorFor(info, 'version');
    expect(door).toMatchObject({ kind: 'no-model', catalogKnown: true });
    if (door.kind !== 'no-model') throw new Error('door');
    expect(door.suggestion?.selector).toBe('acestep:1.5-fast');
    expect(installCommand(door, 'version')).toBe(
      'cantor pull acestep:1.5-fast',
    );
    expect(suggestionFor(info, 'longer')?.selector).toBe('acestep:1.5-fast');
  });

  it('falls back to asking the catalog when the node has never reached it', () => {
    const info = node({
      models: [capabilities.node.models[1]],
      installable: undefined,
    });
    const door = doorFor(info, 'longer');
    expect(door).toEqual({
      kind: 'no-model',
      suggestion: null,
      catalogKnown: false,
    });
    if (door.kind !== 'no-model') throw new Error('door');
    expect(installCommand(door, 'longer')).toBe(
      'cantor list --all --can extend',
    );
  });

  it('an offline node is away, not incapable', () => {
    expect(doorFor(null, 'version')).toEqual({ kind: 'away' });
  });
});

describe('acts on a song from this phone', () => {
  const able = { nodePublicKey: 'a', info: node(), ready: true };
  const textOnly = {
    nodePublicKey: 'b',
    info: node({ models: [capabilities.node.models[1]] }),
    ready: true,
  };
  it('opens on the first node here that can, and says which', () => {
    const door = doorAcross([textOnly, able], 'version', true);
    expect(door).toMatchObject({ kind: 'ready', firstAble: 'a' });
  });
  it('waits for nodes that are away, and suggests an install where none can', () => {
    expect(doorAcross([{ ...able, ready: false }], 'version', true)).toEqual({
      kind: 'away',
    });
    expect(doorAcross([textOnly], 'version', true)).toMatchObject({
      kind: 'no-model',
    });
    expect(doorAcross([], 'version', true)).toEqual({ kind: 'unsupported' });
  });
  it('names a file by what its extension promises', () => {
    expect(mediaTypeOfPath('/Music/a.FLAC')).toBe('audio/flac');
    expect(mediaTypeOfPath('/x/y.m4a')).toBe('audio/mp4');
    expect(mediaTypeOfPath('/x/noext')).toBe('application/octet-stream');
  });
});
