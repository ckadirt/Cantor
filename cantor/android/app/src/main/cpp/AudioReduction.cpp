// A time range of a song, reduced to columns: what `readSamples` in
// `player/createAudioApiPlayer.ts` computes, without holding the song.
//
// The JS path decodes the whole file to floats (about 69 MB for three minutes
// at 44.1 kHz stereo, four times that at 96 kHz) and then loops over every
// sample on the JS thread. Here the same decoders (`AudioDecode.h`) stream the
// range, and each decoded chunk is folded into the buckets as it arrives.
// Memory is one chunk; nothing before the range is decoded after a seek.
//
// The bucket edges are the JS ones — bucket `b` starts at
// `from + floor(span·b/buckets)` and holds at least one frame — and min and max
// start at zero there too, so either path means the same thing to a lens.
//
// The result goes back to Kotlin as one float array:
//   [startSeconds, endSeconds, sampleRate, channels,
//    per channel: min[buckets], max[buckets], rms[buckets],
//    and when channels >= 2: mid[buckets], side[buckets]]
#include <jni.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "AudioDecode.h"

namespace {

/**
 * The running reduction; the same fold as the JS loop, frame by frame.
 *
 * A window with at least one frame per bucket is folded as it streams: frames
 * arrive in order and a pointer walks the edges. A window with fewer frames
 * than buckets — deep L3 — is gathered instead (it is tiny by definition) and
 * reduced with the JS overlap rule, where a one-frame bucket may share its
 * frame with the next.
 */
class Fold {
 public:
  Fold(int64_t from, int64_t span, int buckets, int channels)
      : from_(from),
        span_(span),
        buckets_(buckets),
        channels_(channels),
        low_(static_cast<size_t>(channels) * buckets, 0.f),
        high_(static_cast<size_t>(channels) * buckets, 0.f),
        energy_(static_cast<size_t>(channels) * buckets, 0.0),
        mid_(channels >= 2 ? buckets : 0, 0.0),
        side_(channels >= 2 ? buckets : 0, 0.0) {
    if (span_ < buckets_) gathered_.assign(static_cast<size_t>(span_) * channels_, 0.f);
    nextEdge_ = edge(1);
  }

  /** Fold interleaved frames starting at `first`; true once past the window. */
  bool accept(const float *samples, int frames, int64_t first) {
    const int64_t to = from_ + span_;
    for (int i = 0; i < frames; ++i) {
      const int64_t index = first + i;
      if (index >= to) return true;
      if (index < from_) continue;
      take(index, samples + static_cast<size_t>(i) * channels_);
    }
    return first + frames >= to;
  }

  std::vector<float> finish(double startSeconds, double endSeconds, int rate) {
    if (!gathered_.empty()) reduceGathered();
    std::vector<float> out;
    out.reserve(4 + static_cast<size_t>(buckets_) * (3 * channels_ + 2));
    out.push_back(static_cast<float>(startSeconds));
    out.push_back(static_cast<float>(endSeconds));
    out.push_back(static_cast<float>(rate));
    out.push_back(static_cast<float>(channels_));
    for (int c = 0; c < channels_; ++c) {
      const size_t base = static_cast<size_t>(c) * buckets_;
      out.insert(out.end(), low_.begin() + base, low_.begin() + base + buckets_);
      out.insert(out.end(), high_.begin() + base, high_.begin() + base + buckets_);
      for (int b = 0; b < buckets_; ++b) {
        out.push_back(static_cast<float>(std::sqrt(energy_[base + b] / width(b))));
      }
    }
    if (channels_ >= 2) {
      for (int b = 0; b < buckets_; ++b) out.push_back(static_cast<float>(std::sqrt(mid_[b] / width(b))));
      for (int b = 0; b < buckets_; ++b) out.push_back(static_cast<float>(std::sqrt(side_[b] / width(b))));
    }
    return out;
  }

 private:
  int64_t edge(int b) const { return from_ + span_ * b / buckets_; }

  /** Frames in bucket `b`, the JS way: never fewer than one. */
  double width(int b) const {
    const int64_t start = edge(b);
    return static_cast<double>(std::max(start + 1, edge(b + 1)) - start);
  }

  void take(int64_t index, const float *frame) {
    if (!gathered_.empty()) {
      std::copy(frame, frame + channels_, gathered_.begin() + (index - from_) * channels_);
      return;
    }
    while (bucket_ < buckets_ - 1 && index >= nextEdge_) {
      ++bucket_;
      nextEdge_ = edge(bucket_ + 1);
    }
    add(bucket_, frame);
  }

  void add(int b, const float *frame) {
    for (int c = 0; c < channels_; ++c) {
      const float value = frame[c];
      const size_t at = static_cast<size_t>(c) * buckets_ + b;
      if (value < low_[at]) low_[at] = value;
      if (value > high_[at]) high_[at] = value;
      energy_[at] += static_cast<double>(value) * value;
    }
    if (channels_ >= 2) {
      const float m = (frame[0] + frame[1]) / 2.f;
      const float d = (frame[0] - frame[1]) / 2.f;
      mid_[b] += static_cast<double>(m) * m;
      side_[b] += static_cast<double>(d) * d;
    }
  }

  void reduceGathered() {
    for (int b = 0; b < buckets_; ++b) {
      const int64_t start = edge(b) - from_;
      const int64_t end = std::max(edge(b) + 1, edge(b + 1)) - from_;
      for (int64_t at = start; at < end && at < span_; ++at) {
        add(b, gathered_.data() + at * channels_);
      }
    }
  }

  const int64_t from_;
  const int64_t span_;
  const int buckets_;
  const int channels_;
  std::vector<float> low_;
  std::vector<float> high_;
  std::vector<double> energy_;
  std::vector<double> mid_;
  std::vector<double> side_;
  std::vector<float> gathered_;
  int bucket_ = 0;
  int64_t nextEdge_ = 0;
};

/** The fold as a decoder's sink: made once the stream says what it holds. */
class FoldSink : public cantor::audio::PcmSink {
 public:
  explicit FoldSink(int buckets) : buckets_(buckets) {}
  void begin(int, int channels, int64_t from, int64_t to) override {
    fold_ = std::make_unique<Fold>(from, to - from, buckets_, channels);
  }
  bool accept(const float *samples, int frames, int64_t first) override {
    return fold_->accept(samples, frames, first);
  }
  Fold &fold() { return *fold_; }

 private:
  int buckets_;
  std::unique_ptr<Fold> fold_;
};

std::vector<float> reduce(const std::string &path, double startSeconds, double endSeconds, int buckets) {
  if (buckets <= 0) throw std::runtime_error("Sample window needs a positive bucket count.");
  FoldSink sink(buckets);
  const auto range = cantor::audio::decodeRange(path, startSeconds, endSeconds, sink);
  return sink.fold().finish(static_cast<double>(range.from) / range.rate,
                            static_cast<double>(range.to) / range.rate, range.rate);
}

}  // namespace

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_cantor_app_audio_AudioReduction_reduceNative(JNIEnv *env, jobject /* this */, jstring path,
                                                      jdouble startSeconds, jdouble endSeconds,
                                                      jint buckets) {
  const char *chars = env->GetStringUTFChars(path, nullptr);
  const std::string file(chars);
  env->ReleaseStringUTFChars(path, chars);
  try {
    const std::vector<float> out = reduce(file, startSeconds, endSeconds, buckets);
    jfloatArray array = env->NewFloatArray(static_cast<jsize>(out.size()));
    env->SetFloatArrayRegion(array, 0, static_cast<jsize>(out.size()), out.data());
    return array;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
