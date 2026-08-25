import React from 'react';
import { Skia } from '@shopify/react-native-skia';
import ReactTestRenderer from 'react-test-renderer';
import type { ArtifactView } from '../../../../../protocol/ArtifactView';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import { byTime, layoutField } from '../../../field';
import { FieldA11yList } from '../FieldA11yList';
import { recordFieldPicture } from '../FieldCanvas';
import type { FieldPresentation } from '../useFieldController';

const viewport = { width: 380, height: 800 };
const artifact: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 900,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};
const song: SongHeader = {
  id: 'song-a',
  revision: 1,
  title: 'A field song',
  caption_summary: 'A test song',
  created_at: '2026-08-08T00:00:00Z',
  duration_ms: 11_000,
  model: 'light',
  favorite: false,
  tags: [],
  trashed: false,
  artifacts: [artifact],
};
const entity = {
  key: 'node-a:song-a',
  nodePublicKey: 'node-a',
  entityId: 'song-a',
  kind: 'song' as const,
  createdAtMs: Date.parse(song.created_at),
  tags: [],
};
const presentation: FieldPresentation = {
  entity,
  song,
  backend: {
    nodePubkey: 'node-a',
    relayUrl: 'wss://relay.example',
    petname: 'Studio',
    lastNodeInfo: null,
  },
  ready: true,
  nodeLabels: ['Studio'],
  delivery: artifact,
  localAudio: { state: 'cached', bytes: artifact.byte_length },
};

function paint(color: string) {
  const result = Skia.Paint();
  result.setColor(Skia.Color(color));
  return result;
}

describe('field canvas and accessibility mirror', () => {
  const layout = layoutField({
    entities: [entity],
    arrangement: byTime,
    viewport,
  });
  const camera = {
    x: layout.fieldCenter.x,
    y: layout.fieldCenter.y,
    scale: layout.fitScale,
  };

  it('records one drawable picture from prepared data', () => {
    const display = Skia.Font(undefined, 20);
    const mono = Skia.Font(undefined, 9);
    const picture = recordFieldPicture({
      layout,
      placements: layout.placements,
      camera,
      viewport,
      presentations: new Map([[entity.key, presentation]]),
      palette: {
        bg: '#FFFFFF',
        ink: '#000000',
        muted: '#666666',
        faint: '#A6A6A6',
        line: '#E6E6E6',
      },
      lensKey: 'name',
      fonts: { display, body: display, mono },
      paints: {
        ink: paint('#000000'),
        muted: paint('#666666'),
        faint: paint('#A6A6A6'),
      },
    });
    expect(picture).not.toBeNull();
    // The native SkPicture interface intentionally exposes no bounds getter.
    // Recording successfully is the contract we need here.
    expect(picture).toBeTruthy();
  });

  it('records the playing mark without leaving a stroked paint behind', () => {
    const display = Skia.Font(undefined, 20);
    const mono = Skia.Font(undefined, 9);
    const ink = paint('#000000');
    // CanvasKit's Paint exposes no style getter, so watch the writes instead.
    const styles: number[] = [];
    const setStyle = ink.setStyle.bind(ink);
    ink.setStyle = (style: number) => {
      styles.push(style);
      setStyle(style);
    };
    const record = (playingKey: string | null) =>
      recordFieldPicture({
        layout,
        placements: layout.placements,
        camera,
        viewport,
        presentations: new Map([[entity.key, presentation]]),
        palette: {
          bg: '#FFFFFF',
          ink: '#000000',
          muted: '#666666',
          faint: '#A6A6A6',
          line: '#E6E6E6',
        },
        playingKey,
        lensKey: 'name',
        fonts: { display, body: display, mono },
        paints: { ink, muted: paint('#666666'), faint: paint('#A6A6A6') },
      });

    expect(record(entity.key)).toBeTruthy();
    // Paints are shared across the whole picture: a ring that forgot to restore
    // the fill style would silently outline everything drawn afterwards.
    expect(styles).toContain(1);
    expect(styles[styles.length - 1]).toBe(0);

    styles.length = 0;
    expect(record(null)).toBeTruthy();
    // Nothing is playing, so the ring never runs and the style is never touched.
    expect(styles).toEqual([]);
  });

  it('exposes labelled semantic actions instead of canvas nodes', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(FieldA11yList, {
          focus: null,
          layout,
          level: 'field',
          onSelect: jest.fn(),
          placements: layout.placements,
          presentations: new Map([[entity.key, presentation]]),
        }),
      );
    });
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'A field song, 2026-W32, 11 seconds',
      }),
    ).toBeTruthy();
  });
});
