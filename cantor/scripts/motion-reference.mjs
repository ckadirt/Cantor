#!/usr/bin/env node
// The reference motion analysis of a song, written as JSON: the page
// `docs/interfacealpha/reactive-player.html` run headless.
//
// The page is the reference implementation of the reactive player (its plan,
// M0), so this does not copy its analysis: it evaluates the page's own script
// under Node with a DOM that answers everything and does nothing, hands it the
// song decoded by ffmpeg at the file's own rate (a browser would resample to
// its context's), and calls the page's `analyse()` and `exportMotion()`.
//
//   node scripts/motion-reference.mjs [--page path.html] <song> [<out.json>]
//
// Without an output path the JSON goes to stdout.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let page = resolve(here, '../../docs/interfacealpha/reactive-player.html');
if (args[0] === '--page') {
  page = resolve(args[1]);
  args.splice(0, 2);
}
const [song, out] = args;
if (!song) {
  console.error('usage: motion-reference.mjs [--page page.html] <song> [<out.json>]');
  process.exit(2);
}

/** The song as the page's AudioBuffer would hold it: planar floats, own rate. */
function decode(path) {
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
      'stream=sample_rate,channels', '-of', 'json', path]).toString(),
  ).streams[0];
  const rate = Number(probe.sample_rate);
  const channels = Number(probe.channels);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'f32le',
    '-acodec', 'pcm_f32le', '-'], { maxBuffer: 4 << 30 });
  const interleaved = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  const length = Math.floor(interleaved.length / channels);
  const planes = Array.from({ length: channels }, () => new Float32Array(length));
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) planes[c][i] = interleaved[i * channels + c];
  return {
    sampleRate: rate,
    numberOfChannels: channels,
    length,
    duration: length / rate,
    getChannelData: c => planes[c],
  };
}

/** Anything the page asks of the DOM: callable, settable, and a number when it must be. */
function inert() {
  const target = function () {};
  const proxy = new Proxy(target, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'then') return undefined;
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

const html = readFileSync(page, 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const dom = inert();
const context = vm.createContext({
  document: dom,
  window: dom,
  requestAnimationFrame: () => 0,
  setTimeout,
  clearTimeout,
  URL: dom,
  Blob: dom,
  console,
});
vm.runInContext(script, context, { filename: page });

context.__buffer = decode(song);
context.__name = basename(song);
const result = await vm.runInContext(`(async () => {
  // The shipping knobs (plan, "The shipping numbers"); the stub DOM's sliders
  // read as zero.
  Object.assign(knobs, { gain: 1, attack: .025, release: .26, latency: 0, sections: .55, repeats: 1, filled: true });
  buffer = __buffer;
  recipe = { seed: undefined, id: __name, model: 'upload', durationMs: Math.round(buffer.duration * 1000) };
  song = await analyse(buffer, () => {});
  if (song.structure) labelSegments(song.structure, knobs.repeats);
  rebuildEnvelopes(); rebuildShapes();
  return JSON.stringify(exportMotion(__name));
})()`, context);

if (out) writeFileSync(out, result + '\n');
else process.stdout.write(result + '\n');
