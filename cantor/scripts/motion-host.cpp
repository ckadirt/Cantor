// The motion analysis on the desktop, for `motion-check.mjs`: interleaved
// f32le PCM on stdin, the track as JSON on stdout, timings on stderr.
//
//   motion-host <rate> <channels> < song.f32
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "../android/app/src/main/cpp/motion/MotionAnalysis.h"

using cantor::motion::Analyser;

int main(int argc, char **argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: motion-host <rate> <channels> < pcm.f32\n");
    return 2;
  }
  const int rate = std::atoi(argv[1]), channels = std::atoi(argv[2]);
  Analyser analyser(rate, channels);
  std::vector<float> chunk(4096 * channels);
  double pushing = 0;
  while (true) {
    const size_t read = std::fread(chunk.data(), sizeof(float) * channels, 4096, stdin);
    if (read == 0) break;
    const auto t0 = std::chrono::steady_clock::now();
    analyser.push(chunk.data(), static_cast<int>(read));
    pushing += std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  }
  const auto t0 = std::chrono::steady_clock::now();
  const auto track = analyser.finish();
  const double finishing = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::fprintf(stderr, "features %.3f s, song %.3f s\n", pushing, finishing);

  std::printf("{\"sampleRate\":%d,\"fps\":%.9g,\"F\":%d,\"duration\":%.9g,\"bpm\":%.9g,\"confidence\":%.6g,"
              "\"periodicity\":%.6g,\"snapped\":%.6g,\"timing\":{\"features\":%.6g,\"song\":%.6g},\"beats\":[",
              track.sampleRate, track.fps, track.frames, track.duration, track.bpm, track.confidence,
              track.periodicity, track.snapped, pushing, finishing);
  for (size_t i = 0; i < track.beats.size(); ++i)
    std::printf("%s[%d,%.9g,%d]", i ? "," : "", track.beats[i].f, track.beats[i].t, track.beats[i].down ? 1 : 0);
  std::printf("],\"onsets\":[");
  for (int b = 0; b < 3; ++b) {
    std::printf("%s[", b ? "," : "");
    for (size_t i = 0; i < track.onsets[b].size(); ++i)
      std::printf("%s[%d,%.9g,%.7g]", i ? "," : "", track.onsets[b][i].f, track.onsets[b][i].t, track.onsets[b][i].s);
    std::printf("]");
  }
  std::printf("],\"curves\":{\"step\":10,\"loud\":[");
  for (size_t i = 0; i < track.loud.size(); i += 10) std::printf("%s%.7g", i ? "," : "", track.loud[i]);
  std::printf("],\"sections\":[");
  for (size_t i = 0; i < track.sections.size(); i += 10) std::printf("%s%.7g", i ? "," : "", track.sections[i]);
  std::printf("]},\"structure\":");
  if (!track.hasStructure) {
    std::printf("null}\n");
    return 0;
  }
  std::printf("{\"n\":%d,\"mu\":%.7g,\"sd\":%.7g,\"labels\":%d,\"segments\":[", track.n, track.mu, track.sd, track.labels);
  for (size_t i = 0; i < track.segments.size(); ++i) {
    const auto &s = track.segments[i];
    std::printf("%s{\"a\":%d,\"z\":%d,\"t0\":%.9g,\"t1\":%.9g,\"label\":%d,\"proto\":%d,\"loud\":%.7g,\"low\":%.7g}",
                i ? "," : "", s.a, s.z, s.t0, s.t1, s.label, s.proto, s.loud, s.low);
  }
  std::printf("],\"drops\":[");
  for (size_t i = 0; i < track.drops.size(); ++i) {
    const auto &d = track.drops[i];
    std::printf("%s{\"t\":%.9g,\"from\":%.9g,\"bar\":%.9g,\"strength\":%.7g}", i ? "," : "", d.t, d.from, d.bar, d.strength);
  }
  std::printf("]}}\n");
  return 0;
}
