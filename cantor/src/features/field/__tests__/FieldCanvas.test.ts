import React from 'react';
import { Skia } from '@shopify/react-native-skia';
import ReactTestRenderer from 'react-test-renderer';
import type { ArtifactView } from '../../../../../protocol/ArtifactView';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import { byTime, layoutField } from '../../../field';
import { FieldA11yList } from '../FieldA11yList';
import { drawJobMark } from '../FieldCanvas';
import { nodePresentation } from '../useFieldController';

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
  durationMs: 0,
  tags: [],
};
const presentation = nodePresentation({
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
});

function paint(color: string) {
  const result = Skia.Paint();
  result.setColor(Skia.Color(color));
  return result;
}

describe('job marks and the accessibility mirror', () => {
  const layout = layoutField({
    entities: [entity],
    arrangement: byTime,
    viewport,
  });
  it('draws a job mark without claiming progress the node never counted', () => {
    const mono = Skia.Font(undefined, 9);
    const ink = paint('#000000');
    const styles: number[] = [];
    const setStyle = ink.setStyle.bind(ink);
    ink.setStyle = (style: number) => {
      styles.push(style);
      setStyle(style);
    };
    const jobEntity = { ...entity, key: 'node-a:job-1', kind: 'job' as const };
    const recorder = Skia.PictureRecorder();
    drawJobMark(
      recorder.beginRecording(Skia.XYWHRect(-256, -128, 512, 256)),
      {
        paints: {
          ink,
          muted: paint('#666666'),
          faint: paint('#A6A6A6'),
          outline: paint('#000000'),
        },
        fonts: { mono },
      },
      { x: 0, y: 0 },
      {
        entity: jobEntity,
        job: {
          id: 'job-1',
          revision: 1,
          state: 'running' as const,
          stage: 'diffuse' as const,
          model: 'light',
          created_at: '2026-08-10T00:00:00Z',
          updated_at: '2026-08-10T00:00:00Z',
        },
        backend: presentation.backend,
        nodeLabels: ['Studio'],
        caption: 'a slow piano piece',
        request: null,
        declaredStages: ['plan', 'codes', 'diffuse', 'decode'] as const,
      },
      { dot: 1, row: 1, song: 0, grain: 0 },
    );
    const picture = recorder.finishRecordingAsPicture();

    expect(picture).toBeTruthy();
    // The ring is stroked, and the shared paint is handed back as a fill.
    expect(styles).toContain(1);
    expect(styles[styles.length - 1]).toBe(0);
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
