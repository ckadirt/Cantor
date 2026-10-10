// A song's motion track, measured natively: the whole file streamed through
// the player's own decoders (`../AudioDecode.h`) into the analyser
// (`MotionAnalysis.h`), packed for Kotlin (`MotionTrack.kt`) as one double
// array. Version 1:
//
//   [version, sampleRate, duration, bpm, confidence, periodicity,
//    decodeMs, featuresMs, songMs, peakBytes,
//    beats, onsets low, onsets mid, onsets high, sections, drops,
//    loudStep, loudCount, sectionsStep, sectionsCount,
//    beats (t, down)…, onsets (t, strength)… per band,
//    sections (t0, t1, label, loud, low, a, z, proto)…, drops (t, from, bar, strength)…,
//    loud…, sections…]
//
// Times in seconds. The two curves are sampled every `step` seconds from 0.
#include <jni.h>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "../AudioDecode.h"
#include "MotionAnalysis.h"

namespace {

constexpr double kVersion = 1;
constexpr int kLoudEvery = 5;       // hops: 20 per second
constexpr int kSectionsEvery = 25;  // hops: 4 per second
constexpr double kWholeSong = 1e9;  // seconds: past any song's end

using Clock = std::chrono::steady_clock;

class AnalyserSink : public cantor::audio::PcmSink {
 public:
  void begin(int rate, int channels, int64_t, int64_t) override {
    analyser_ = std::make_unique<cantor::motion::Analyser>(rate, channels);
  }
  bool accept(const float *samples, int frames, int64_t) override {
    const auto t0 = Clock::now();
    analyser_->push(samples, frames);
    features_ += Clock::now() - t0;
    return false;
  }
  cantor::motion::Analyser &analyser() { return *analyser_; }
  double featuresMs() const { return std::chrono::duration<double, std::milli>(features_).count(); }

 private:
  std::unique_ptr<cantor::motion::Analyser> analyser_;
  Clock::duration features_{};
};

std::vector<double> measure(const std::string &path) {
  const auto start = Clock::now();
  AnalyserSink sink;
  cantor::audio::decodeRange(path, 0, kWholeSong, sink);
  const auto decoded = Clock::now();
  const auto track = sink.analyser().finish();
  const auto end = Clock::now();
  const double songMs = std::chrono::duration<double, std::milli>(end - decoded).count();
  const double decodeMs = std::chrono::duration<double, std::milli>(decoded - start).count() - sink.featuresMs();

  std::vector<double> out;
  const auto &on = track.onsets;
  const size_t loudCount = (track.loud.size() + kLoudEvery - 1) / kLoudEvery;
  const size_t sectionsCount = (track.sections.size() + kSectionsEvery - 1) / kSectionsEvery;
  out.insert(out.end(), {kVersion, static_cast<double>(track.sampleRate), track.duration, track.bpm, track.confidence,
                         track.periodicity, decodeMs, sink.featuresMs(), songMs, track.peakBytes,
                         static_cast<double>(track.beats.size()), static_cast<double>(on[0].size()),
                         static_cast<double>(on[1].size()), static_cast<double>(on[2].size()),
                         static_cast<double>(track.segments.size()), static_cast<double>(track.drops.size()),
                         kLoudEvery / track.fps, static_cast<double>(loudCount), kSectionsEvery / track.fps,
                         static_cast<double>(sectionsCount)});
  for (const auto &b : track.beats) out.insert(out.end(), {b.t, b.down ? 1.0 : 0.0});
  for (const auto &band : on)
    for (const auto &o : band) out.insert(out.end(), {o.t, o.s});
  for (const auto &s : track.segments)
    out.insert(out.end(), {s.t0, s.t1, static_cast<double>(s.label), s.loud, s.low, static_cast<double>(s.a),
                           static_cast<double>(s.z), static_cast<double>(s.proto)});
  for (const auto &d : track.drops) out.insert(out.end(), {d.t, d.from, d.bar, d.strength});
  for (size_t i = 0; i < track.loud.size(); i += kLoudEvery) out.push_back(track.loud[i]);
  for (size_t i = 0; i < track.sections.size(); i += kSectionsEvery) out.push_back(track.sections[i]);
  return out;
}

}  // namespace

extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_cantor_app_audio_MotionTrack_measureNative(JNIEnv *env, jobject /* this */, jstring path) {
  const char *chars = env->GetStringUTFChars(path, nullptr);
  const std::string file(chars);
  env->ReleaseStringUTFChars(path, chars);
  try {
    const std::vector<double> out = measure(file);
    jdoubleArray array = env->NewDoubleArray(static_cast<jsize>(out.size()));
    env->SetDoubleArrayRegion(array, 0, static_cast<jsize>(out.size()), out.data());
    return array;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
