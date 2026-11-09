#include "Mp3Encode.h"

#include <algorithm>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#include "lame.h"

namespace cantor::mp3 {
namespace {

/** Samples per MPEG-1 Layer III frame. */
constexpr int64_t kFrameSamples = 1152;
/** Frames handed to LAME per call. */
constexpr int kChunkFrames = 4096;

struct LameDeleter {
  void operator()(lame_global_flags *lame) const { lame_close(lame); }
};
using Lame = std::unique_ptr<lame_global_flags, LameDeleter>;

Lame open(const PcmSource &source, const Options &options) {
  Lame lame(lame_init());
  if (!lame) throw std::runtime_error("LAME could not start.");
  lame_set_in_samplerate(lame.get(), source.rate());
  lame_set_out_samplerate(lame.get(), source.rate());
  lame_set_num_channels(lame.get(), source.channels());
  lame_set_mode(lame.get(), source.channels() == 1 ? MONO : JOINT_STEREO);
  lame_set_VBR(lame.get(), vbr_off);
  lame_set_brate(lame.get(), options.kbps);
  lame_set_quality(lame.get(), options.quality);
  // Self-contained frames, so segments join (see the header).
  lame_set_disable_reservoir(lame.get(), 1);
  // Only audio frames: the tags are written by Kotlin, and a Xing frame
  // would stand in the middle of a joined file.
  lame_set_bWriteVbrTag(lame.get(), 0);
  lame_set_write_id3tag_automatic(lame.get(), 0);
  if (lame_init_params(lame.get()) < 0) throw std::runtime_error("LAME refused the settings.");
  return lame;
}

/** Every frame LAME makes from song frames [from, to), flush included. */
std::vector<uint8_t> encodeRange(const PcmSource &source, const Options &options, int64_t from, int64_t to) {
  Lame lame = open(source, options);
  const int channels = source.channels();
  std::vector<uint8_t> out;
  std::vector<uint8_t> buffer(kChunkFrames * 5 / 4 + 7200);
  std::vector<float> held;
  const auto feed = [&](const float *samples, int frames) {
    const int written =
        channels == 2
            ? lame_encode_buffer_interleaved_ieee_float(lame.get(), samples, frames, buffer.data(),
                                                        static_cast<int>(buffer.size()))
            : lame_encode_buffer_ieee_float(lame.get(), samples, samples, frames, buffer.data(),
                                            static_cast<int>(buffer.size()));
    if (written < 0) throw std::runtime_error("LAME failed to encode (" + std::to_string(written) + ").");
    out.insert(out.end(), buffer.begin(), buffer.begin() + written);
  };
  int64_t next = from;
  source.read(from, to, [&](const float *samples, int frames, int64_t first) {
    // Audio that starts after the frame asked for would shift every frame of
    // this segment off the grid: refuse rather than join it out of time.
    if (first > next) throw std::runtime_error("The decoder skipped ahead of the segment.");
    // Keep only [next, to): the decoder may start early, and repeats nothing.
    int64_t skip = std::max<int64_t>(0, next - first);
    int64_t end = std::min<int64_t>(first + frames, to);
    while (first + skip < end) {
      const int count = static_cast<int>(std::min<int64_t>(kChunkFrames, end - first - skip));
      feed(samples + skip * channels, count);
      skip += count;
    }
    next = std::max(next, end);
    return next >= to;
  });
  if (next < to) throw std::runtime_error("The song ended before its length.");
  const int flushed = lame_encode_flush(lame.get(), buffer.data(), static_cast<int>(buffer.size()));
  if (flushed < 0) throw std::runtime_error("LAME failed to finish.");
  out.insert(out.end(), buffer.begin(), buffer.begin() + flushed);
  return out;
}

/** Frames [first, first + count) of a run of frames; count < 0 is all the rest. */
void appendFrames(const std::vector<uint8_t> &frames, int64_t first, int64_t count, Result &into) {
  size_t at = 0;
  int64_t index = 0;
  while (at < frames.size()) {
    const size_t length = frameLength(frames.data() + at, frames.size() - at);
    if (length == 0) throw std::runtime_error("LAME wrote something that is not an MP3 frame.");
    if (index >= first && (count < 0 || index < first + count)) {
      into.mp3.insert(into.mp3.end(), frames.begin() + at, frames.begin() + at + length);
      into.mp3Frames += 1;
    }
    at += length;
    index += 1;
  }
  if (count >= 0 && index < first + count) throw std::runtime_error("A segment came out short.");
}

}  // namespace

size_t frameLength(const uint8_t *at, size_t available) {
  if (available < 4 || at[0] != 0xFF || (at[1] & 0xE0) != 0xE0) return 0;
  const int version = (at[1] >> 3) & 0x03;  // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const int layer = (at[1] >> 1) & 0x03;    // 1: Layer III
  const int bitrateIndex = (at[2] >> 4) & 0x0F;
  const int rateIndex = (at[2] >> 2) & 0x03;
  const int padding = (at[2] >> 1) & 0x01;
  if (version == 1 || layer != 1 || bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3) return 0;
  static const int kBitrates[2][15] = {
      {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320},  // MPEG-1
      {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},      // MPEG-2, 2.5
  };
  static const int kRates[3] = {44100, 48000, 32000};
  const bool mpeg1 = version == 3;
  const int rate = kRates[rateIndex] >> (mpeg1 ? 0 : version == 2 ? 1 : 2);
  const int kbps = kBitrates[mpeg1 ? 0 : 1][bitrateIndex];
  const size_t length = static_cast<size_t>((mpeg1 ? 144000 : 72000) * kbps / rate + padding);
  return length <= available ? length : 0;
}

Result encode(const PcmSource &source, const Options &options) {
  const int64_t total = source.frames();
  if (total <= 0) throw std::runtime_error("The song has no audio.");
  // The song in MP3 frames, and where each segment's own frames begin.
  const int64_t frames = (total + kFrameSamples - 1) / kFrameSamples;
  const int count = static_cast<int>(std::clamp<int64_t>(
      std::min<int64_t>(options.segments, frames / std::max(1, options.minSegmentFrames)), 1, 64));
  std::vector<int64_t> bounds(count + 1);
  for (int k = 0; k <= count; ++k) bounds[k] = frames * k / count;

  std::vector<std::vector<uint8_t>> parts(count);
  std::vector<int64_t> lead(count);
  std::vector<std::exception_ptr> failures(count);
  std::vector<std::thread> threads;
  for (int k = 0; k < count; ++k) {
    // Its own frames, with up to `overlapFrames` either side to drop.
    const int64_t start = std::max<int64_t>(0, bounds[k] - options.overlapFrames);
    lead[k] = bounds[k] - start;
    const int64_t from = start * kFrameSamples;
    const int64_t to =
        k == count - 1 ? total : std::min(total, (bounds[k + 1] + options.overlapFrames) * kFrameSamples);
    threads.emplace_back([&, k, from, to] {
      try {
        parts[k] = encodeRange(source, options, from, to);
      } catch (...) {
        failures[k] = std::current_exception();
      }
    });
  }
  for (auto &thread : threads) thread.join();
  for (const auto &failure : failures) {
    if (failure) std::rethrow_exception(failure);
  }

  Result result;
  result.segments = count;
  for (int k = 0; k < count; ++k) {
    // The last segment keeps everything to its end: the flush's tail is the song's.
    appendFrames(parts[k], lead[k], k == count - 1 ? -1 : bounds[k + 1] - bounds[k], result);
    std::vector<uint8_t>().swap(parts[k]);
  }
  return result;
}

}  // namespace cantor::mp3
