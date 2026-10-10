// Decoding a song as react-native-audio-api decodes it, for every native
// reader of audio: the reduction to columns (`AudioReduction.cpp`) and the
// motion track (`motion/MotionTrackJni.cpp`).
//
// "As audio-api decodes it" is literal: audio-api decodes `.mp4`, `.m4a` and
// `.aac` with its FFmpeg build (which has nothing else in it) and everything
// else with miniaudio plus its Vorbis and Opus backends. This makes the same
// choice by the same rule (`needsFFmpegByPath`), links the same FFmpeg
// libraries, and calls audio-api's own miniaudio through the symbols its
// library exports — so what is measured is exactly what the player plays.
//
// The platform decoder (MediaCodec) was tried first and measured slower than
// the JS path it was meant to replace: its per-buffer plumbing cost 3.5 s of
// CPU on a 3 min MP3 before any work, it has no ALAC, and it hands 24-bit FLAC
// back as 16-bit. See docs/import/log.md, I1.
#pragma once

#include <cstdint>
#include <string>

namespace cantor::audio {

/** Where decoded audio goes, chunk by chunk, in order. */
class PcmSink {
 public:
  virtual ~PcmSink() = default;
  /** The stream is open: its rate, channels, and the frames [from, to) it will deliver. */
  virtual void begin(int rate, int channels, int64_t from, int64_t to) = 0;
  /** Interleaved float frames starting at song frame `first`; true once nothing more is wanted. */
  virtual bool accept(const float *samples, int frames, int64_t first) = 0;
};

struct DecodedRange {
  int rate;
  int channels;
  int64_t from, to;
};

/**
 * Decode [startSeconds, endSeconds) of the file at `path` into `sink`,
 * streaming: memory is one chunk. Frame 0 is the first sample the decoder
 * delivers. Throws `std::runtime_error` with the decoder's reason.
 */
DecodedRange decodeRange(const std::string &path, double startSeconds, double endSeconds, PcmSink &sink);

}  // namespace cantor::audio
