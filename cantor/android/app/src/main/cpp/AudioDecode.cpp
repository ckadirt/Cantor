// See AudioDecode.h. Moved here unchanged from AudioReduction.cpp, which
// streamed the same loops into its fold.
#include "AudioDecode.h"

#include <dlfcn.h>

#include <algorithm>
#include <cctype>
#include <climits>
#include <cmath>
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

namespace cantor::audio {

namespace {

std::string ffmpegError(const char *what, int code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(code, buffer, sizeof(buffer));
  return std::string(what) + ": " + buffer;
}

/** Owns every FFmpeg object of one decode, released in reverse order. */
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

DecodedRange decodeWithFfmpeg(const std::string &path, double startSeconds, double endSeconds,
                              PcmSink &sink) {
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
  sink.begin(rate, channels, from, to);

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
      if (sink.accept(converted.data(), count, next)) done = true;
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
  return {rate, channels, from, to};
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

DecodedRange decodeWithMiniaudio(const std::string &path, double startSeconds, double endSeconds,
                                 PcmSink &sink) {
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
  sink.begin(rate, channels, from, to);

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
    if (read > 0 && sink.accept(chunk.data(), static_cast<int>(read), next)) break;
    next += static_cast<int64_t>(read);
    if (result != MA_SUCCESS || read < kChunkFrames) break;
  }
  return {rate, channels, from, to};
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

}  // namespace

DecodedRange decodeRange(const std::string &path, double startSeconds, double endSeconds, PcmSink &sink) {
  return needsFfmpeg(path) ? decodeWithFfmpeg(path, startSeconds, endSeconds, sink)
                           : decodeWithMiniaudio(path, startSeconds, endSeconds, sink);
}

}  // namespace cantor::audio
