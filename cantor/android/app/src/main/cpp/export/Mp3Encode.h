// A song as an MP3, made on several cores at once
// (internal/docs/plans/take-it-plan.md, E2).
//
// One thread of LAME takes about 3.5 s for a 3-minute song on the phones Cantor
// is tested on, so the song is cut into segments that are decoded and encoded
// side by side and joined. The joins must not be heard:
//
// - Every segment starts on the MP3 frame grid (1152 samples), so its frames
//   line up with the frames a single pass would make.
// - Every segment encodes a few frames before and after its own and drops
//   them, so the frames it keeps were analysed with the same neighbours a
//   single pass would have given them (window switching, the MDCT's overlap).
// - The bit reservoir is off: a kept frame never points into a dropped one.
//   At 320 kbps it has nothing left to lend anyway.
//
// With one segment this is exactly LAME's own single pass.
#pragma once

#include <cstdint>
#include <functional>
#include <vector>

namespace cantor::mp3 {

/** Where a song's PCM comes from: the player's decoders on the phone, memory in a test. */
class PcmSource {
 public:
  virtual ~PcmSource() = default;
  virtual int rate() const = 0;
  virtual int channels() const = 0;
  /** The song's length in frames (one sample per channel). */
  virtual int64_t frames() const = 0;
  /**
   * Deliver at least frames [from, to), in order, as interleaved floats in
   * [-1, 1]. Each chunk starts at song frame `first`; frames outside the
   * range may be delivered and are ignored. `chunk` returns true once nothing
   * more is wanted. Safe to call from several threads at once.
   */
  using Chunk = std::function<bool(const float *samples, int frames, int64_t first)>;
  virtual void read(int64_t from, int64_t to, const Chunk &chunk) const = 0;
};

/** KNOBS */
struct Options {
  /** Constant bitrate: 320 kbps is the most MP3 has, and 160k Opus into it is transparent. */
  int kbps = 320;
  /** LAME's own default (3): q2 doubles the time, q5 saves a fifth. */
  int quality = 3;
  /** Segments encoded at once: 4 measured best on both test phones. */
  int segments = 4;
  /** Frames each segment encodes beyond its own on either side, then drops (~100 ms). */
  int overlapFrames = 4;
  /** No segment shorter than this many frames (~5 s): a short song is one pass. */
  int minSegmentFrames = 200;
};

struct Result {
  /** MPEG audio frames only: no ID3 tag, no Xing/Info frame. */
  std::vector<uint8_t> mp3;
  int segments = 0;
  int64_t mp3Frames = 0;
};

/** Encode the whole song. Throws std::runtime_error with the reason. */
Result encode(const PcmSource &source, const Options &options);

/** The length in bytes of the MPEG audio frame at `at`, or 0 if none is there. */
size_t frameLength(const uint8_t *at, size_t available);

}  // namespace cantor::mp3
