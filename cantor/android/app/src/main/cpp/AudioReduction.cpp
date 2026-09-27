// A time range of a song, reduced to columns: what `readSamples` in
// `player/createAudioApiPlayer.ts` computes, without holding the song.
//
// The JS path decodes the whole file to floats (about 69 MB for three minutes
// at 44.1 kHz stereo, four times that at 96 kHz) and then loops over every
// sample on the JS thread. Here the same decoders stream the range, and each
// decoded chunk is folded into the buckets as it arrives. Memory is one chunk;
// nothing before the range is decoded after a seek.
//
// "The same decoders" is literal: react-native-audio-api decodes `.mp4`,
// `.m4a` and `.aac` with its FFmpeg build (which has nothing else in it) and
// everything else with miniaudio plus its Vorbis and Opus backends. This file
// makes the same choice by the same rule (`needsFFmpegByPath`), links the same
// FFmpeg libraries, and calls audio-api's own miniaudio through the symbols its
// library exports — so a column is drawn from exactly what the player plays.
//
// The platform decoder (MediaCodec) was tried first and measured slower than
// the JS path it was meant to replace: its per-buffer plumbing cost 3.5 s of
// CPU on a 3 min MP3 before any work, it has no ALAC, and it hands 24-bit FLAC
// back as 16-bit. See docs/import/log.md, I1.
//
// The bucket edges are the JS ones — bucket `b` starts at
// `from + floor(span·b/buckets)` and holds at least one frame — and min and max
// start at zero there too, so either path means the same thing to a lens.
//
// The result goes back to Kotlin as one float array:
//   [startSeconds, endSeconds, sampleRate, channels,
//    per channel: min[buckets], max[buckets], rms[buckets],
//    and when channels >= 2: mid[buckets], side[buckets]]

#include <dlfcn.h>
#include <jni.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <climits>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}

// Declarations only: the implementation lives in audio-api's library, compiled
// with nothing but MA_DEBUG_OUTPUT, which changes no struct layout.
#include <miniaudio.h>

namespace {

std::string ffmpegError(const char *what, int code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(code, buffer, sizeof(buffer));
  return std::string(what) + ": " + buffer;
}

/** Owns every FFmpeg object of one reduction, released in reverse order. */
struct Decoder {
  AVFormatContext *format = nullptr;
  AVCodecContext *codec = nullptr;
  SwrContext *swr = nullptr;
  AVPacket *packet = nullptr;
  AVFrame *frame = nullptr;

  ~Decoder() {
    av_frame_free(&frame);
    av_packet_free(&packet);
    swr_free(&swr);
    avcodec_free_context(&codec);
    avformat_close_input(&format);
  }
};

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

/**
 * How far before a window a seek lands, in seconds.
 *
 * A codec with overlapping frames (AAC, Opus) cannot rebuild the first frame
 * after a seek on its own: the frame it decodes there is only half the sound.
 * Starting this much earlier and discarding up to the window lets it settle, so
 * a seeked window matches a whole-song decode (measured: AAC was off by 0.009
 * RMS in a 2 s window without it, Opus by 0.001). Longer than Opus's 80 ms
 * pre-roll.
 */
constexpr double kPrerollSeconds = 0.1;

/** Clamp a position to the song, the JS way. */
int64_t clampFrame(double value, int64_t frames) {
  if (!std::isfinite(value)) return 0;
  return std::min(std::max(static_cast<int64_t>(std::floor(value)), static_cast<int64_t>(0)), frames);
}

std::vector<float> reduceWithFfmpeg(const std::string &path, double startSeconds, double endSeconds,
                                    int buckets) {
  Decoder d;
  int result = avformat_open_input(&d.format, path.c_str(), nullptr, nullptr);
  if (result < 0) throw std::runtime_error(ffmpegError("open", result));
  result = avformat_find_stream_info(d.format, nullptr);
  if (result < 0) throw std::runtime_error(ffmpegError("stream info", result));
  const int streamIndex = av_find_best_stream(d.format, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (streamIndex < 0) throw std::runtime_error("No audio stream.");
  AVStream *stream = d.format->streams[streamIndex];

  const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (codec == nullptr) throw std::runtime_error("No decoder.");
  d.codec = avcodec_alloc_context3(codec);
  if (d.codec == nullptr) throw std::runtime_error("No codec context.");
  result = avcodec_parameters_to_context(d.codec, stream->codecpar);
  if (result < 0) throw std::runtime_error(ffmpegError("codec parameters", result));
  result = avcodec_open2(d.codec, codec, nullptr);
  if (result < 0) throw std::runtime_error(ffmpegError("codec open", result));

  const int rate = d.codec->sample_rate;
  const int channels = d.codec->ch_layout.nb_channels;
  if (rate <= 0 || channels <= 0) throw std::runtime_error("The stream declares no rate or channels.");

  // Interleaved float at the source's own rate and channel count, as the JS
  // decode delivers it.
  result = swr_alloc_set_opts2(&d.swr, &d.codec->ch_layout, AV_SAMPLE_FMT_FLT, rate,
                               &d.codec->ch_layout, d.codec->sample_fmt, rate, 0, nullptr);
  if (result < 0 || swr_init(d.swr) < 0) throw std::runtime_error("Could not set up conversion.");

  // Frame 0 is the first sample the decoder delivers, as in the JS buffer.
  // The stream's start time is where that sample sits on the timeline (an MP3
  // with encoder delay starts a few milliseconds in), so every position is
  // measured from it.
  const AVRational base = stream->time_base;
  const int64_t startPts = stream->start_time != AV_NOPTS_VALUE ? stream->start_time : 0;
  const double durationSeconds =
      stream->duration != AV_NOPTS_VALUE ? stream->duration * av_q2d(base)
      : d.format->duration != AV_NOPTS_VALUE ? d.format->duration / static_cast<double>(AV_TIME_BASE)
                                              : endSeconds;
  const auto frames = static_cast<int64_t>(std::floor(durationSeconds * rate));
  const int64_t from = clampFrame(startSeconds * rate, frames);
  const int64_t to = std::max(from + 1, clampFrame(endSeconds * rate, frames));
  Fold fold(from, to - from, buckets, channels);

  if (from > 0) {
    const int64_t landing = std::max<int64_t>(0, from - static_cast<int64_t>(kPrerollSeconds * rate));
    const int64_t target = startPts + av_rescale_q(landing, AVRational{1, rate}, base);
    result = av_seek_frame(d.format, streamIndex, target, AVSEEK_FLAG_BACKWARD);
    if (result < 0) throw std::runtime_error(ffmpegError("seek", result));
    avcodec_flush_buffers(d.codec);
  }

  d.packet = av_packet_alloc();
  d.frame = av_frame_alloc();
  if (d.packet == nullptr || d.frame == nullptr) throw std::runtime_error("Out of memory.");
  std::vector<float> converted;
  // Where the next decoded frame sits. Only the first frame after the open or
  // the seek is placed by its timestamp; from there frames are counted, which
  // does not depend on every packet carrying a good one.
  int64_t next = -1;
  bool done = false;

  auto drain = [&]() {
    while (!done) {
      const int received = avcodec_receive_frame(d.codec, d.frame);
      if (received == AVERROR(EAGAIN) || received == AVERROR_EOF) return;
      if (received < 0) throw std::runtime_error(ffmpegError("decode", received));
      if (next < 0) {
        const int64_t pts = d.frame->best_effort_timestamp;
        next = pts == AV_NOPTS_VALUE ? 0 : av_rescale_q(pts - startPts, base, AVRational{1, rate});
      }
      const int capacity = swr_get_out_samples(d.swr, d.frame->nb_samples);
      converted.resize(static_cast<size_t>(std::max(capacity, 0)) * channels);
      auto *out = reinterpret_cast<uint8_t *>(converted.data());
      const int count = swr_convert(d.swr, &out, capacity,
                                    const_cast<const uint8_t **>(d.frame->extended_data),
                                    d.frame->nb_samples);
      av_frame_unref(d.frame);
      if (count < 0) throw std::runtime_error(ffmpegError("convert", count));
      if (fold.accept(converted.data(), count, next)) done = true;
      next += count;
    }
  };

  while (!done) {
    const int read = av_read_frame(d.format, d.packet);
    if (read < 0) break;
    if (d.packet->stream_index == streamIndex) {
      const int sent = avcodec_send_packet(d.codec, d.packet);
      av_packet_unref(d.packet);
      // A damaged packet costs its own frames, not the window.
      if (sent < 0 && sent != AVERROR(EAGAIN) && sent != AVERROR_INVALIDDATA) {
        throw std::runtime_error(ffmpegError("send", sent));
      }
      drain();
    } else {
      av_packet_unref(d.packet);
    }
  }
  if (!done) {
    avcodec_send_packet(d.codec, nullptr);
    drain();
  }
  if (next < 0) throw std::runtime_error("The decoder produced no audio.");
  return fold.finish(static_cast<double>(from) / rate, static_cast<double>(to) / rate, rate);
}

/**
 * audio-api's miniaudio, found in its already-loaded library.
 *
 * Looked up at run time rather than linked, so building this library does not
 * depend on audio-api's being built first. Every entry is checked once.
 */
struct MiniAudio {
  decltype(&ma_decoder_config_init) configInit = nullptr;
  decltype(&ma_decoder_init_file) initFile = nullptr;
  decltype(&ma_decoder_uninit) uninit = nullptr;
  decltype(&ma_decoder_read_pcm_frames) read = nullptr;
  decltype(&ma_decoder_seek_to_pcm_frame) seek = nullptr;
  decltype(&ma_decoder_get_length_in_pcm_frames) length = nullptr;
  ma_decoding_backend_vtable *backends[2] = {nullptr, nullptr};

  static const MiniAudio &get() {
    static const MiniAudio instance = load();
    return instance;
  }

 private:
  static MiniAudio load() {
    void *library = dlopen("libreact-native-audio-api.so", RTLD_NOW | RTLD_NOLOAD);
    if (library == nullptr) library = dlopen("libreact-native-audio-api.so", RTLD_NOW);
    if (library == nullptr) throw std::runtime_error("react-native-audio-api is not loaded.");
    MiniAudio m;
    m.configInit = reinterpret_cast<decltype(m.configInit)>(dlsym(library, "ma_decoder_config_init"));
    m.initFile = reinterpret_cast<decltype(m.initFile)>(dlsym(library, "ma_decoder_init_file"));
    m.uninit = reinterpret_cast<decltype(m.uninit)>(dlsym(library, "ma_decoder_uninit"));
    m.read = reinterpret_cast<decltype(m.read)>(dlsym(library, "ma_decoder_read_pcm_frames"));
    m.seek = reinterpret_cast<decltype(m.seek)>(dlsym(library, "ma_decoder_seek_to_pcm_frame"));
    m.length = reinterpret_cast<decltype(m.length)>(dlsym(library, "ma_decoder_get_length_in_pcm_frames"));
    // Each is a pointer variable holding the backend's vtable.
    auto vorbis = static_cast<ma_decoding_backend_vtable **>(dlsym(library, "ma_decoding_backend_libvorbis"));
    auto opus = static_cast<ma_decoding_backend_vtable **>(dlsym(library, "ma_decoding_backend_libopus"));
    if (m.configInit == nullptr || m.initFile == nullptr || m.uninit == nullptr || m.read == nullptr ||
        m.seek == nullptr || m.length == nullptr || vorbis == nullptr || opus == nullptr) {
      throw std::runtime_error("react-native-audio-api does not export the miniaudio decoder.");
    }
    m.backends[0] = *vorbis;
    m.backends[1] = *opus;
    return m;
  }
};

/** How many frames one read asks miniaudio for, as audio-api reads them. */
constexpr ma_uint64 kChunkFrames = 4096;

std::vector<float> reduceWithMiniaudio(const std::string &path, double startSeconds,
                                       double endSeconds, int buckets) {
  const MiniAudio &ma = MiniAudio::get();
  // As audio-api configures it (`makeDecoderConfig`): float, the source's own
  // channels and rate, the Vorbis and Opus backends.
  ma_decoder_config config = ma.configInit(ma_format_f32, 0, 0);
  config.ppCustomBackendVTables = const_cast<ma_decoding_backend_vtable **>(ma.backends);
  config.customBackendCount = 2;
  ma_decoder decoder;
  ma_result result = ma.initFile(path.c_str(), &config, &decoder);
  if (result != MA_SUCCESS) throw std::runtime_error("miniaudio open failed (" + std::to_string(result) + ")");
  struct Closer {
    const MiniAudio &ma;
    ma_decoder *decoder;
    ~Closer() { ma.uninit(decoder); }
  } closer{ma, &decoder};

  const int rate = static_cast<int>(decoder.outputSampleRate);
  const int channels = static_cast<int>(decoder.outputChannels);
  if (rate <= 0 || channels <= 0) throw std::runtime_error("The stream declares no rate or channels.");

  // Some formats (Vorbis) cannot say their length up front; then the request
  // alone bounds the window, and a range past the end reads as silence, as a
  // short JS buffer does.
  ma_uint64 length = 0;
  const bool known = ma.length(&decoder, &length) == MA_SUCCESS && length > 0;
  const int64_t frames = known ? static_cast<int64_t>(length) : INT64_MAX / 2;
  const int64_t from = clampFrame(startSeconds * rate, frames);
  const int64_t to = std::max(from + 1, clampFrame(endSeconds * rate, frames));
  Fold fold(from, to - from, buckets, channels);

  // miniaudio seeks to the exact frame, so frames are counted from the landing.
  const int64_t landing = std::max<int64_t>(0, from - static_cast<int64_t>(kPrerollSeconds * rate));
  if (landing > 0) {
    result = ma.seek(&decoder, static_cast<ma_uint64>(landing));
    if (result != MA_SUCCESS) throw std::runtime_error("miniaudio seek failed (" + std::to_string(result) + ")");
  }
  std::vector<float> chunk(static_cast<size_t>(kChunkFrames) * channels);
  int64_t next = landing;
  while (next < to) {
    ma_uint64 read = 0;
    result = ma.read(&decoder, chunk.data(), kChunkFrames, &read);
    if (read > 0 && fold.accept(chunk.data(), static_cast<int>(read), next)) break;
    next += static_cast<int64_t>(read);
    if (result != MA_SUCCESS || read < kChunkFrames) break;
  }
  return fold.finish(static_cast<double>(from) / rate, static_cast<double>(to) / rate, rate);
}

/** audio-api's own rule (`needsFFmpegByPath`): these go to FFmpeg, the rest to miniaudio. */
bool needsFfmpeg(const std::string &path) {
  std::string lower(path);
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return std::tolower(c); });
  for (const char *extension : {".mp4", ".m4a", ".aac"}) {
    const std::string ext(extension);
    if (lower.size() >= ext.size() && lower.compare(lower.size() - ext.size(), ext.size(), ext) == 0) {
      return true;
    }
  }
  return false;
}

std::vector<float> reduce(const std::string &path, double startSeconds, double endSeconds, int buckets) {
  if (buckets <= 0) throw std::runtime_error("Sample window needs a positive bucket count.");
  return needsFfmpeg(path) ? reduceWithFfmpeg(path, startSeconds, endSeconds, buckets)
                           : reduceWithMiniaudio(path, startSeconds, endSeconds, buckets);
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
