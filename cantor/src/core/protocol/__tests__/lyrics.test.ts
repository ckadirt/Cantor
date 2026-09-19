import { parseNodeInfo } from '../node';
import { lyricsContractFor } from '../lyrics';

const fixture =
  require('../../../../../protocol/fixtures/v2/node-info.json').node;

it('carries model lyrics capabilities through node info into the composer contract', () => {
  const lyrics = {
    can_generate: true,
    requires_lyrics: false,
    writer_label: 'FUTURE',
    instrumental_text: '[Instrumental]',
  };
  const decoded = parseNodeInfo({
    ...fixture,
    models: [
      { selector: 'future:1', family: 'future', engine: 'future', lyrics },
    ],
  });
  expect(decoded?.models[0].lyrics).toEqual(lyrics);
  expect(lyricsContractFor(decoded?.models[0])).toEqual({
    writerLabel: 'FUTURE',
    requiresLyrics: false,
    instrumentalLyrics: '[Instrumental]',
  });
});

it('ignores malformed optional capabilities without losing the node', () => {
  const decoded = parseNodeInfo({
    ...fixture,
    models: [
      {
        selector: 'future:1',
        family: 'future',
        engine: 'future',
        lyrics: { can_generate: 'yes', requires_lyrics: false },
      },
    ],
  });
  expect(decoded).not.toBeNull();
  expect(decoded?.models[0].lyrics).toBeUndefined();
  expect(lyricsContractFor(decoded?.models[0]).writerLabel).toBeNull();
});

it('decodes the shared capabilities fixture', () => {
  const wire = require('../../../../../protocol/fixtures/v2/node-info-lyrics.json');
  expect(parseNodeInfo(wire.node)?.models[0].lyrics).toEqual(
    wire.node.models[0].lyrics,
  );
});
