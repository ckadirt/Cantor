// The MP3 encoder (`Mp3Encode.h`) fed by the player's own decoders
// (`../AudioDecode.h`), for Kotlin (`export/Mp3Encoder.kt`). Each segment
// decodes its own range of the song on its own thread, so decoding is spread
// over the cores as well and the whole song is never held in memory.
#include <jni.h>

#include <chrono>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "../AudioDecode.h"
#include "Mp3Encode.h"

namespace {

using cantor::audio::PcmSink;
using cantor::mp3::PcmSource;

constexpr double kWholeSong = 1e9;  // seconds: past any song's end

/** Learns the stream's shape and stops at the first chunk. */
class Probe : public PcmSink {
 public:
  int rate = 0, channels = 0;
  int64_t frames = 0;
  void begin(int r, int c, int64_t, int64_t to) override {
    rate = r;
    channels = c;
    frames = to;
  }
  bool accept(const float *, int, int64_t) override { return true; }
};

class Forward : public PcmSink {
 public:
  explicit Forward(const PcmSource::Chunk &chunk) : chunk_(chunk) {}
  void begin(int, int, int64_t, int64_t) override {}
  bool accept(const float *samples, int frames, int64_t first) override { return chunk_(samples, frames, first); }

 private:
  const PcmSource::Chunk &chunk_;
};

class DecodedSong : public PcmSource {
 public:
  explicit DecodedSong(std::string path) : path_(std::move(path)) {
    Probe probe;
    cantor::audio::decodeRange(path_, 0, kWholeSong, probe);
    // A format that cannot say its length reports a window, not a song.
    if (probe.frames <= 0 || probe.frames > static_cast<int64_t>(probe.rate) * 60 * 60 * 3) {
      throw std::runtime_error("The song's length is unknown.");
    }
    rate_ = probe.rate;
    channels_ = probe.channels;
    frames_ = probe.frames;
    if (channels_ != 1 && channels_ != 2) throw std::runtime_error("Only mono and stereo become MP3.");
  }
  int rate() const override { return rate_; }
  int channels() const override { return channels_; }
  int64_t frames() const override { return frames_; }
  void read(int64_t from, int64_t to, const Chunk &chunk) const override {
    // A frame early on both ends: seconds round, and late is the one thing
    // the encoder must never be given.
    Forward sink(chunk);
    cantor::audio::decodeRange(path_, static_cast<double>(std::max<int64_t>(0, from - 1)) / rate_,
                               static_cast<double>(to + 1) / rate_, sink);
  }

 private:
  std::string path_;
  int rate_ = 0, channels_ = 0;
  int64_t frames_ = 0;
};

std::string text(JNIEnv *env, jstring value) {
  const char *chars = env->GetStringUTFChars(value, nullptr);
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

}  // namespace

/**
 * Encode the song at `source` into raw MP3 frames at `target`. Returns
 * [segments, mp3Frames, bytes, sampleRate, milliseconds], or throws
 * IllegalStateException with the reason.
 */
extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_cantor_app_export_Mp3Encoder_encodeNative(JNIEnv *env, jobject /* this */, jstring source, jstring target,
                                                   jint kbps, jint quality, jint segments) {
  try {
    const auto start = std::chrono::steady_clock::now();
    DecodedSong song(text(env, source));
    cantor::mp3::Options options;
    options.kbps = kbps;
    options.quality = quality;
    options.segments = segments;
    const auto result = cantor::mp3::encode(song, options);
    std::ofstream out(text(env, target), std::ios::binary | std::ios::trunc);
    out.write(reinterpret_cast<const char *>(result.mp3.data()), static_cast<std::streamsize>(result.mp3.size()));
    out.close();
    if (!out) throw std::runtime_error("The MP3 could not be written.");
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    const double values[] = {static_cast<double>(result.segments), static_cast<double>(result.mp3Frames),
                             static_cast<double>(result.mp3.size()), static_cast<double>(song.rate()), ms};
    jdoubleArray array = env->NewDoubleArray(5);
    env->SetDoubleArrayRegion(array, 0, 5, values);
    return array;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
