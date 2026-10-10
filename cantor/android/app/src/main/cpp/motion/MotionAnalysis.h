// The motion track of a song: its beats, onsets, sections and drops, measured
// from the decoded audio, for the player that moves in time with the music.
//
// A port of `analyse`, `beatSync`, `structureOf` and `labelSegments` from
// docs/interfacealpha/reactive-player.html, which is the reference: every
// constant here is the page's, and `scripts/motion-check.mjs` holds the two
// against each other on the fixture songs. Where this file departs from the
// page it says so and why (search for "Departs").
//
// Pure C++: no JNI, no decoder. Feed it interleaved float frames as they are
// decoded (`push`), then `finish` once. It keeps per-hop features, never the
// song: about 30 floats per 10 ms.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

namespace cantor::motion {

struct Onset {
  int f;     // hop index
  double t;  // seconds
  double s;  // strength, 0..1
};

struct Beat {
  int f;
  double t;
  bool down;
};

struct Segment {
  int a, z;        // beat indices, z exclusive
  double t0, t1;   // seconds
  int label = 0;   // same letter, same section
  int proto = 0;   // the first segment with this label
  double loud = 0, low = 0;
};

struct Drop {
  double t, from, bar, strength;
};

struct Track {
  int sampleRate = 0;
  int hop = 0;
  double fps = 0;
  int frames = 0;  // hops: F
  double duration = 0;
  double bpm = 0;
  // Departs: the page has no confidence. How sure the beat grid is, 0..1 —
  // see `beatConfidence`.
  double confidence = 0;
  double periodicity = 0;  // the onset curve's autocorrelation at the period
  double snapped = 0;      // the share of grid beats that found an onset
  // The most the analysis held at once, in bytes: features, history and the
  // matrix. The decoder's own buffers are not counted.
  double peakBytes = 0;
  std::vector<Beat> beats;
  std::array<std::vector<Onset>, 3> onsets;
  std::vector<float> loud;      // per hop, 0..1: 80 ms of loudness
  std::vector<float> sections;  // per hop, 0..1: 4 s of loudness
  bool hasStructure = false;
  int n = 0;  // beats in the structure
  double mu = 0, sd = 0;
  int labels = 0;
  std::vector<Segment> segments;
  std::vector<Drop> drops;
};

struct Options {
  double repeats = 1.0;  // the page's REPEATS knob, in standard deviations
};

class Analyser {
 public:
  Analyser(int sampleRate, int channels, Options options = {});
  ~Analyser();
  Analyser(const Analyser &) = delete;
  Analyser &operator=(const Analyser &) = delete;

  /** Interleaved frames, in order, as many at a time as the decoder gives. */
  void push(const float *interleaved, int frames);
  /** Everything after the last frame; the analyser is spent afterwards. */
  Track finish();

  /** The FFT size for onsets at `sampleRate`: 2048 at 44.1 and 48 kHz. */
  static int onsetFftSize(int sampleRate);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace cantor::motion
