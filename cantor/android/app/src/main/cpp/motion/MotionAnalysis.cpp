// See MotionAnalysis.h. Function and variable names follow the page's, so the
// two can be read side by side: `analyse` is `Impl::frame` plus `finish`,
// `beatSync`, `structureOf` and `labelSegments` keep their names.
#include "MotionAnalysis.h"

extern "C" {
#include "pffft/pffft_double.h"
}

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <thread>
#include <atomic>

namespace cantor::motion {

namespace {

constexpr double kPi = 3.14159265358979323846;

/** JavaScript's Math.round: half up, also for negatives. */
inline long jsRound(double x) { return static_cast<long>(std::floor(x + 0.5)); }

inline double clamp01(double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * The magnitude spectrum of n real samples (n a power of two, at least 32).
 *
 * Departs: the page runs a hand-written n-point complex radix-2 FFT on real
 * input. pffft's real transform (double precision, SIMD; see `pffft/`) gives
 * the same spectrum to the last few bits for a fraction of the time — the
 * fixtures still match exactly. Unnormalised, as the page's is.
 */
class RealFft {
 public:
  explicit RealFft(int n)
      : setup_(pffftd_new_setup(n, PFFFT_REAL)),
        in_(static_cast<double *>(pffftd_aligned_malloc(sizeof(double) * n))),
        out_(static_cast<double *>(pffftd_aligned_malloc(sizeof(double) * n))),
        work_(static_cast<double *>(pffftd_aligned_malloc(sizeof(double) * n))) {}
  ~RealFft() {
    pffftd_aligned_free(work_);
    pffftd_aligned_free(out_);
    pffftd_aligned_free(in_);
    pffftd_destroy_setup(setup_);
  }
  RealFft(const RealFft &) = delete;
  RealFft &operator=(const RealFft &) = delete;

  /** Where the caller writes the n samples. */
  double *input() { return in_; }

  /** |X[k]| for k in [1, last), into `out[k]`. */
  void magnitudes(int last, double *out) {
    pffftd_transform_ordered(setup_, in_, out_, work_, PFFFT_FORWARD);
    // Ordered real output: X[0], X[n/2], then re and im of X[1] … X[n/2 − 1].
    for (int k = 1; k < last; ++k) {
      const double re = out_[2 * k], im = out_[2 * k + 1];
      out[k] = std::sqrt(re * re + im * im);
    }
  }

 private:
  PFFFTD_Setup *setup_;
  double *in_, *out_, *work_;
};

/** The page's `percentile`: sort a copy, take floor(p·(n−1)), never 0. */
double percentile(const std::vector<float> &values, double p) {
  if (values.empty()) return 1e-9;
  std::vector<float> s(values);
  const size_t at = std::min(s.size() - 1, static_cast<size_t>(std::floor(p * (s.size() - 1))));
  std::nth_element(s.begin(), s.begin() + static_cast<long>(at), s.end());
  const double v = s[at];
  return v != 0 ? v : 1e-9;
}

/** The page's `movingMean`: the mean of x over ±half, shrinking at the ends. */
std::vector<float> movingMean(const std::vector<float> &x, long half) {
  const long n = static_cast<long>(x.size());
  std::vector<float> out(x.size());
  double sum = 0;
  long lo = 0, hi = -1;
  for (long i = 0; i < n; ++i) {
    while (hi < std::min(n - 1, i + half)) sum += x[++hi];
    while (lo < i - half) sum -= x[lo++];
    out[i] = static_cast<float>(sum / (hi - lo + 1));
  }
  return out;
}

}  // namespace

int Analyser::onsetFftSize(int sampleRate) {
  // Departs: the page's N is 2048 at every rate, which at 96 kHz leaves the
  // 30–150 Hz band two bins wide (the 96 kHz fixture's beats were 480 ms off).
  // The same 43 ms window at any rate, to the nearest power of two: 2048 at
  // 44.1 and 48 kHz, so the reference's own rates are untouched.
  const double ideal = sampleRate * 2048.0 / 48000.0;
  return 1 << std::max(8, static_cast<int>(std::lround(std::log2(ideal))));
}

struct Analyser::Impl {
  Impl(int rate, int channels, Options opts)
      : sr(rate),
        channels(std::max(1, channels)),
        options(opts),
        hop(static_cast<int>(jsRound(rate / 100.0))),
        fps(static_cast<double>(rate) / hop),
        N(onsetFftSize(rate)),
        NC(4 * onsetFftSize(rate)),
        threads(static_cast<int>(std::clamp(std::thread::hardware_concurrency(), 1u, 4u))),
        win(N),
        chromaWin(NC) {
    for (int i = 0; i < N; ++i) win[i] = 0.5 - 0.5 * std::cos(2 * kPi * i / N);
    for (int i = 0; i < NC; ++i) chromaWin[i] = 0.5 - 0.5 * std::cos(2 * kPi * i / NC);
    auto binOf = [&](double hz) {
      return static_cast<int>(std::max(1L, std::min(static_cast<long>(N / 2 - 1), jsRound(hz * N / sr))));
    };
    bands = {{{binOf(30), binOf(150)}, {binOf(150), binOf(2500)}, {binOf(2500), binOf(11000)}}};
    for (int i = 0; i < 13; ++i) timbreEdges[i] = binOf(60 * std::pow(11000.0 / 60, i / 12.0));
    // The spectrum above the last band edge is never read.
    lastBin = std::max(bands[2][1], timbreEdges[12]) + 1;
    pcOf.assign(NC / 2, -1);
    pcWeight.assign(NC / 2, 0.f);
    const double df = static_cast<double>(sr) / NC;
    chromaLast = 1;
    for (int k = 1; k < NC / 2; ++k) {
      const double hz = k * df;
      if (hz < 130 || hz > 5000) continue;
      const double midi = 12 * std::log2(hz / 440) + 69;
      const double near = static_cast<double>(jsRound(midi));
      if (std::abs(midi - near) > 0.35) continue;
      pcOf[k] = static_cast<int>(((static_cast<long>(near) % 12) + 12) % 12);
      pcWeight[k] = static_cast<float>(std::min(1.0, df / (0.0595 * hz)));
      chromaLast = k + 1;
    }
    for (int i = 0; i < threads; ++i) spaces.push_back(std::make_unique<Workspace>(N, NC));
  }

  ~Impl() { join(); }

  // ---- streaming: per-hop features as samples arrive -----------------------
  //
  // Departs: the page computes hop after hop. Here hops are cut into blocks of
  // `kBlock`, each block is computed by up to four threads while the decoder
  // fills the next, and every number is the same: a thread starting mid-block
  // recomputes the one spectrum before its first hop, and blocks and their
  // chunks start on multiples of 4, where chroma is computed.

  static constexpr int kBlock = 512;  // hops: ~5 s
  static constexpr int kChunk = 32;   // hops a thread takes at a time; a multiple of 4

  /** One thread's FFTs and spectra. */
  struct Workspace {
    Workspace(int n, int nc) : onsetFft(n), chromaFft(nc), spectrum(n / 2, 0.0), chromaSpectrum(nc / 2, 0.0), cur(n / 2, 0.0), prev(n / 2, 0.0) {}
    RealFft onsetFft, chromaFft;
    std::vector<double> spectrum, chromaSpectrum, cur, prev;
  };

  /** Hops [h0, h1) and every sample their windows read, zero outside the song. */
  struct Block {
    int h0 = 0, h1 = 0;
    int64_t base = 0;
    std::vector<float> samples;
  };

  void push(const float *data, int frames) {
    for (int i = 0; i < frames; ++i) {
      const float l = data[static_cast<size_t>(i) * channels];
      const float r = channels > 1 ? data[static_cast<size_t>(i) * channels + 1] : l;
      mono.push_back((l + r) * 0.5f);
      // Time-domain, over this hop only.
      const double m = (l + r) * 0.5, sd = (l - r) * 0.5;
      hopE += (static_cast<double>(l) * l + static_cast<double>(r) * r) * 0.5;
      hopEm += m * m;
      hopEs += sd * sd;
      hopPeak = std::max(hopPeak, static_cast<double>(std::max(std::abs(l), std::abs(r))));
      if (++inHop == hop) {
        rms.push_back(static_cast<float>(std::sqrt(hopE / hop)));
        peak.push_back(static_cast<float>(hopPeak));
        mid.push_back(static_cast<float>(std::sqrt(hopEm / hop)));
        side.push_back(static_cast<float>(std::sqrt(hopEs / hop)));
        hopE = hopEm = hopEs = hopPeak = 0;
        inHop = 0;
      }
    }
    received += frames;
    // A hop's spectra need samples up to its centre plus half the chroma
    // window; blocks of hops that have them go to the threads.
    const int64_t reach = received - (hop >> 1) - NC / 2;
    const int ready = reach < 0 ? 0 : static_cast<int>(reach / hop) + 1;
    while (ready - dispatched >= kBlock) dispatch(dispatched + kBlock, false);
    peakMono = std::max(peakMono, static_cast<double>(mono.capacity()) * 4);
  }

  /** Mono sample `s` of the song, zero outside it. */
  inline float sample(int64_t s, int64_t length) const {
    if (s < 0 || s >= length || s < historyStart) return 0.f;
    return mono[static_cast<size_t>(s - historyStart)];
  }

  /** Hand hops [dispatched, h1) to the threads; returns while they work. */
  void dispatch(int h1, bool atEnd) {
    join();
    const int h0 = dispatched;
    for (auto &f : flux) f.resize(h1);
    chroma.resize(static_cast<size_t>(h1) * 12);
    timbre.resize(static_cast<size_t>(h1) * 12);
    auto block = std::make_shared<Block>();
    block->h0 = h0;
    block->h1 = h1;
    block->base = static_cast<int64_t>(h0) * hop + (hop >> 1) - NC / 2;
    const int64_t end = static_cast<int64_t>(h1 - 1) * hop + (hop >> 1) + NC / 2;
    const int64_t length = atEnd ? received : std::numeric_limits<int64_t>::max();
    block->samples.resize(static_cast<size_t>(end - block->base));
    for (int64_t s = block->base; s < end; ++s) block->samples[static_cast<size_t>(s - block->base)] = sample(s, length);
    peakBlock = std::max(peakBlock, static_cast<double>(block->samples.capacity()) * 4);
    dispatched = h1;
    trimHistory();
    // Chunks of `kChunk` hops, taken by whichever thread is free: a phone's
    // cores are not alike (two fast and six slow on the Xiaomi), and equal
    // parts left every block waiting for a slow one.
    auto next = std::make_shared<std::atomic<int>>(h0);
    for (int i = 0; i < threads; ++i) {
      Workspace *ws = spaces[i].get();
      running.emplace_back([this, block, next, h1, ws] {
        for (int a = next->fetch_add(kChunk); a < h1; a = next->fetch_add(kChunk)) {
          hops(*block, a, std::min(h1, a + kChunk), *ws);
        }
      });
    }
  }

  void join() {
    for (auto &t : running) t.join();
    running.clear();
  }

  /** The onset spectrum of hop f, as log magnitudes, into `out`. */
  void onsetSpectrum(const Block &block, int f, Workspace &ws, std::vector<double> &out) const {
    const float *at = block.samples.data() + (static_cast<int64_t>(f) * hop + (hop >> 1) - N / 2 - block.base);
    double *frameBuf = ws.onsetFft.input();
    for (int i = 0; i < N; ++i) frameBuf[i] = at[i] * win[i];
    ws.onsetFft.magnitudes(lastBin, ws.spectrum.data());
    for (int k = 1; k < lastBin; ++k) out[k] = std::log1p(1000 * ws.spectrum[k] / (N / 4.0));
  }

  /** Hops [a, b) of a block: the page's per-hop loop. */
  void hops(const Block &block, int a, int b, Workspace &ws) {
    if (a > 0) onsetSpectrum(block, a - 1, ws, ws.prev);
    else std::fill(ws.prev.begin(), ws.prev.end(), 0.0);
    for (int f = a; f < b; ++f) {
      onsetSpectrum(block, f, ws, ws.cur);
      const auto &cur = ws.cur, &prev = ws.prev;
      for (int band = 0; band < 3; ++band) {
        double s = 0;
        for (int k = bands[band][0]; k < bands[band][1]; ++k) {
          const double d = cur[k] - prev[k];
          if (d > 0) s += d;
        }
        flux[band][f] = static_cast<float>(s / (bands[band][1] - bands[band][0]));
      }
      if (f % 4 == 0) {
        const float *at = block.samples.data() + (static_cast<int64_t>(f) * hop + (hop >> 1) - NC / 2 - block.base);
        double *chromaBuf = ws.chromaFft.input();
        for (int i = 0; i < NC; ++i) chromaBuf[i] = at[i] * chromaWin[i];
        ws.chromaFft.magnitudes(chromaLast, ws.chromaSpectrum.data());
        std::array<float, 12> v{};
        for (int k = 1; k < chromaLast; ++k) {
          if (pcOf[k] < 0) continue;
          v[pcOf[k]] += static_cast<float>(std::log1p(1000 * ws.chromaSpectrum[k] / (NC / 4.0)) * pcWeight[k]);
        }
        for (int j = f; j < std::min(b, f + 4); ++j) std::copy(v.begin(), v.end(), chroma.begin() + static_cast<long>(j) * 12);
      }
      for (int t = 0; t < 12; ++t) {
        const int k0 = timbreEdges[t], k1 = std::max(k0 + 1, timbreEdges[t + 1]);
        double s = 0;
        for (int k = k0; k < k1; ++k) s += cur[k];
        timbre[static_cast<size_t>(f) * 12 + t] = static_cast<float>(s / (k1 - k0));
      }
      std::swap(ws.prev, ws.cur);
    }
  }

  void trimHistory() {
    // Keep from the next block's first window.
    const int64_t keep = static_cast<int64_t>(dispatched) * hop + (hop >> 1) - NC / 2;
    const int64_t drop = keep - historyStart;
    if (drop > 1 << 16) {
      mono.erase(mono.begin(), mono.begin() + drop);
      historyStart = keep;
    }
  }

  // ---- the song: beats, then form -----------------------------------------

  Track finish() {
    const int F = std::max(1, static_cast<int>(received / hop));
    // The last hops' windows reach past the end, which reads as silence.
    if (dispatched < F) dispatch(F, true);
    join();
    flux[0].resize(F);
    flux[1].resize(F);
    flux[2].resize(F);
    chroma.resize(static_cast<size_t>(F) * 12);
    timbre.resize(static_cast<size_t>(F) * 12);
    rms.resize(F);
    peak.resize(F);
    const double featureBytes =
        4.0 * (flux[0].capacity() * 3 + chroma.capacity() + timbre.capacity() + rms.capacity() * 4) +
        8.0 * (N + NC) * 4 * threads + peakBlock * 2;
    peakMono = std::max(peakMono, static_cast<double>(mono.capacity()) * 4);
    mono.clear();
    mono.shrink_to_fit();

    Track track;
    track.sampleRate = sr;
    track.hop = hop;
    track.fps = fps;
    track.frames = F;
    track.duration = static_cast<double>(received) / sr;

    // Novelty per band: flux over its local mean, rectified, on the song's scale.
    std::array<std::vector<float>, 3> novelty;
    for (int b = 0; b < 3; ++b) {
      const auto m = movingMean(flux[b], jsRound(0.2 * fps));
      std::vector<float> out(F);
      for (int i = 0; i < F; ++i) out[i] = std::max(0.f, flux[b][i] - m[i]);
      const double p = percentile(out, 0.97);
      for (int i = 0; i < F; ++i) out[i] = static_cast<float>(std::min(1.5, out[i] / p));
      novelty[b] = std::move(out);
    }
    // Each onset moved to the hop near it where the energy rises most.
    auto refine = [&](int i) {
      int best = i;
      double rise = -std::numeric_limits<double>::infinity();
      for (int j = std::max(1, i - 2); j <= std::min(F - 1, i + 4); ++j) {
        const double d = static_cast<double>(rms[j]) - rms[j - 1];
        if (d > rise) {
          rise = d;
          best = j;
        }
      }
      return best;
    };
    for (int b = 0; b < 3; ++b) {
      const auto &o = novelty[b];
      const long gap = jsRound(0.05 * fps);
      long last = -1000000000;
      for (int i = 3; i < F - 3; ++i) {
        const double v = o[i];
        if (v < 0.25) continue;
        bool top = true;
        for (int j = i - 3; j <= i + 3; ++j) {
          if (o[j] > v) {
            top = false;
            break;
          }
        }
        if (top && i - last >= gap) {
          const int at = refine(i);
          track.onsets[b].push_back({at, at / fps, std::min(1.0, v)});
          last = i;
        }
      }
    }

    // Tempo: autocorrelation of the combined onset curve, weighted toward 120.
    std::vector<float> combo(F);
    double mean = 0;
    for (int i = 0; i < F; ++i) {
      combo[i] = static_cast<float>(novelty[0][i] + novelty[1][i] + 0.6 * novelty[2][i]);
      mean += combo[i];
    }
    mean /= F;
    double varr = 0;
    for (int i = 0; i < F; ++i) {
      combo[i] = static_cast<float>(combo[i] - mean);
      varr += static_cast<double>(combo[i]) * combo[i];
    }
    double stdev = std::sqrt(varr / F);
    if (stdev == 0) stdev = 1;
    for (int i = 0; i < F; ++i) combo[i] = static_cast<float>(combo[i] / stdev);
    const int minLag = static_cast<int>(std::floor(fps * 60 / 210));
    const int maxLag = static_cast<int>(std::ceil(fps * 60 / 55));
    std::vector<double> ac(maxLag + 2, 0.0);
    for (int lag = minLag - 1; lag <= maxLag + 1; ++lag) {
      double s = 0;
      for (int i = 0; i + lag < F; ++i) s += static_cast<double>(combo[i]) * combo[i + lag];
      ac[lag] = s / (F - lag);
    }
    int bestLag = minLag;
    double bestScore = -std::numeric_limits<double>::infinity();
    for (int lag = minLag; lag <= maxLag; ++lag) {
      const double bpm = 60 * fps / lag;
      const double l = std::log2(bpm / 120) / 0.9;
      const double w = std::exp(-0.5 * l * l);
      if (ac[lag] * w > bestScore) {
        bestScore = ac[lag] * w;
        bestLag = lag;
      }
    }
    const double a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1], den = a - 2 * b + c;
    const double period = bestLag + (den != 0 ? 0.5 * (a - c) / den : 0);
    track.bpm = 60 * fps / period;
    track.periodicity = b;

    // Beats: dynamic programming over the onset curve (Ellis 2007). The
    // penalty depends only on the distance, so it is tabled.
    const double tight = 100;
    std::vector<double> score(F, 0.0);
    std::vector<int> back(F, -1);
    const long maxGap = jsRound(2 * period) + 2;
    std::vector<double> penalty(static_cast<size_t>(maxGap) + 1, 0.0);
    for (long d = 1; d <= maxGap; ++d) {
      const double l = std::log(d / period);
      penalty[d] = tight * l * l;
    }
    for (int t = 0; t < F; ++t) {
      const long lo = std::max(0L, jsRound(t - 2 * period)), hi = jsRound(t - period / 2);
      double best = -std::numeric_limits<double>::infinity();
      int at = -1;
      for (long p = lo; p <= hi; ++p) {
        const double v = score[p] - penalty[t - p];
        if (v > best) {
          best = v;
          at = static_cast<int>(p);
        }
      }
      score[t] = combo[t] + (at >= 0 ? best : 0);
      back[t] = at;
    }
    int end = F - 1;
    for (int t = std::max(0, F - static_cast<int>(jsRound(period))); t < F; ++t) {
      if (score[t] > score[end]) end = t;
    }
    std::vector<int> beatFrames;
    for (int t = end; t >= 0; t = back[t]) beatFrames.push_back(t);
    std::reverse(beatFrames.begin(), beatFrames.end());
    // Each beat onto the refined onset under it, within 50 ms.
    const long near = jsRound(0.05 * fps);
    std::vector<int> hits;
    for (const auto &list : track.onsets)
      for (const auto &o : list) hits.push_back(o.f);
    std::sort(hits.begin(), hits.end());
    struct Snap {
      int f;
      bool onset;
    };
    std::vector<Snap> snapped;
    snapped.reserve(beatFrames.size());
    int found = 0;
    for (const int f : beatFrames) {
      int best = -1;
      auto it = std::lower_bound(hits.begin(), hits.end(), static_cast<int>(f - near));
      for (; it != hits.end() && *it <= f + near; ++it) {
        if (best < 0 || std::abs(*it - f) < std::abs(best - f)) best = *it;
      }
      if (best >= 0) ++found;
      snapped.push_back({best < 0 ? f : best, best >= 0});
    }
    track.snapped = beatFrames.empty() ? 0 : static_cast<double>(found) / beatFrames.size();
    size_t first = 0, last = snapped.size();
    while (first < last && !snapped[first].onset) ++first;
    while (last > first && !snapped[last - 1].onset) --last;
    beatFrames.clear();
    for (size_t i = first; i < last; ++i) beatFrames.push_back(snapped[i].f);

    const double loudP = percentile(rms, 0.9);
    // Downbeats: the phase of four whose beats carry the most low.
    auto lowAt = [&](int f) {
      double m = 0;
      for (int j = std::max(0, f - 3); j <= std::min(F - 1, f + 3); ++j) m = std::max(m, static_cast<double>(novelty[0][j]));
      return m;
    };
    std::array<double, 4> phaseSum{};
    for (size_t i = 0; i < beatFrames.size(); ++i) phaseSum[i % 4] += lowAt(beatFrames[i]);
    const int phase = static_cast<int>(std::max_element(phaseSum.begin(), phaseSum.end()) - phaseSum.begin());
    for (size_t i = 0; i < beatFrames.size(); ++i) {
      track.beats.push_back({beatFrames[i], beatFrames[i] / fps, static_cast<int>(i % 4) == phase});
    }
    track.confidence = beatConfidence(track.periodicity, track.snapped);

    // Loudness, short and long, on the song's own scale.
    std::vector<float> loudRaw(F);
    for (int i = 0; i < F; ++i) loudRaw[i] = static_cast<float>(rms[i] / loudP);
    track.loud = movingMean(loudRaw, jsRound(0.04 * fps));
    track.sections = movingMean(loudRaw, jsRound(2 * fps));
    for (int i = 0; i < F; ++i) {
      track.loud[i] = static_cast<float>(clamp01(track.loud[i]));
      track.sections[i] = static_cast<float>(clamp01(track.sections[i]));
    }

    structureOf(track, loudRaw);
    // Beat-synchronous features and the matrix's upper triangle, as structureOf holds them.
    const double n = static_cast<double>(track.beats.size());
    track.peakBytes = featureBytes + peakMono + 4.0 * F * 4 + 4.0 * (n * 26 + n * (n + 1) / 2);
    return track;
  }

  /**
   * How sure the grid is, 0..1. Departs: the page has none (the plan's
   * "Songs with no beat"). A real beat repeats: the onset curve's
   * autocorrelation at the period is 0.38–0.83 across the fixture songs and
   * 0.10 for the drone, which the grid is laid over all the same. The share of
   * grid beats that found an onset was the plan's second sign and turned out
   * to say nothing — 0.99 for the drone, whose onsets are everywhere — so it
   * is reported and not used.
   */
  static double beatConfidence(double periodicity, double /* snapped */) {
    return clamp01((periodicity - 0.15) / 0.15);
  }

  // ---- beatSync, structureOf, labelSegments -------------------------------

  void structureOf(Track &track, const std::vector<float> &loudRaw) {
    const int F = track.frames;
    const auto &beats = track.beats;
    const int n = static_cast<int>(beats.size());
    if (n < 24) return;
    // beatSync: per beat, chroma (peak 1), timbre (z-scored), loudness, low.
    std::vector<float> bc(static_cast<size_t>(n) * 12, 0.f), bt(static_cast<size_t>(n) * 12, 0.f);
    std::vector<float> bl(n, 0.f), blow(n, 0.f);
    for (int i = 0; i < n; ++i) {
      const int a = beats[i].f;
      const int z = std::max(a + 1, i + 1 < n ? beats[i + 1].f : std::min(F, a + static_cast<int>(jsRound(fps * 0.5))));
      for (int f = a; f < z && f < F; ++f) {
        for (int p = 0; p < 12; ++p) {
          bc[i * 12 + p] += chroma[static_cast<size_t>(f) * 12 + p];
          bt[i * 12 + p] += timbre[static_cast<size_t>(f) * 12 + p];
        }
        bl[i] += loudRaw[f];
      }
      const int len = z - a;
      float m = 0;
      for (int p = 0; p < 12; ++p) {
        bt[i * 12 + p] /= len;
        m = std::max(m, bc[i * 12 + p]);
      }
      for (int p = 0; p < 12; ++p) bc[i * 12 + p] /= (m != 0 ? m : 1);
      bl[i] /= len;
      blow[i] = (bt[i * 12] + bt[i * 12 + 1]) / 2;
    }
    for (int p = 0; p < 12; ++p) {
      double mu = 0, sd = 0;
      for (int i = 0; i < n; ++i) mu += bt[i * 12 + p];
      mu /= n;
      for (int i = 0; i < n; ++i) sd += (bt[i * 12 + p] - mu) * (bt[i * 12 + p] - mu);
      sd = std::sqrt(sd / n);
      if (sd == 0) sd = 1;
      for (int i = 0; i < n; ++i) bt[i * 12 + p] = static_cast<float>((bt[i * 12 + p] - mu) / sd);
    }

    // The matrix, upper triangle only: four beats stacked, half chroma cosine,
    // half timbre cosine.
    const int D = 4;
    auto cosine = [&](const std::vector<float> &A, int i, int j) {
      double s = 0, a = 0, b = 0;
      for (int d = 0; d < D; ++d) {
        const size_t ii = static_cast<size_t>(std::min(n - 1, i + d)) * 12, jj = static_cast<size_t>(std::min(n - 1, j + d)) * 12;
        for (int p = 0; p < 12; ++p) {
          const double x = A[ii + p], y = A[jj + p];
          s += x * y;
          a += x * x;
          b += y * y;
        }
      }
      const double norm = std::sqrt(a * b);
      return s / (norm != 0 ? norm : 1);
    };
    std::vector<float> S(static_cast<size_t>(n) * (n + 1) / 2);
    auto at = [n](int i, int j) {
      if (i > j) std::swap(i, j);
      return static_cast<size_t>(i) * n - static_cast<size_t>(i) * (i - 1) / 2 + (j - i);
    };
    for (int i = 0; i < n; ++i)
      for (int j = i; j < n; ++j) S[at(i, j)] = static_cast<float>(0.5 * cosine(bc, i, j) + 0.5 * (cosine(bt, i, j) * 0.5 + 0.5));
    double mu = 0, sd = 0;
    long count = 0;
    for (int i = 0; i < n; ++i)
      for (int j = i + 4; j < n; ++j) {
        mu += S[at(i, j)];
        ++count;
      }
    mu /= count != 0 ? count : 1;
    for (int i = 0; i < n; ++i)
      for (int j = i + 4; j < n; ++j) sd += (S[at(i, j)] - mu) * (S[at(i, j)] - mu);
    sd = std::sqrt(sd / (count != 0 ? count : 1));

    // Foote's checkerboard along the diagonal.
    const int K = 16;
    std::vector<double> kernel(4 * K * K);
    for (int i = -K; i < K; ++i)
      for (int j = -K; j < K; ++j)
        kernel[(i + K) * 2 * K + (j + K)] =
            ((i < 0) == (j < 0) ? 1 : -1) * std::exp(-((i + 0.5) * (i + 0.5) + (j + 0.5) * (j + 0.5)) / (2.0 * (K / 2.0) * (K / 2.0)));
    std::vector<float> nov(n);
    for (int b = 0; b < n; ++b) {
      double s = 0;
      for (int i = -K; i < K; ++i) {
        const int x = b + i;
        if (x < 0 || x >= n) continue;
        for (int j = -K; j < K; ++j) {
          const int y = b + j;
          if (y < 0 || y >= n) continue;
          s += kernel[(i + K) * 2 * K + (j + K)] * S[at(x, y)];
        }
      }
      nov[b] = static_cast<float>(std::max(0.0, s));
    }
    double nm = 0, ns = 0;
    for (const float v : nov) nm += v;
    nm /= n;
    for (const float v : nov) ns += (v - nm) * (v - nm);
    ns = std::sqrt(ns / n);
    std::vector<int> cuts{0};
    for (int b = 4; b < n - 4; ++b) {
      const double v = nov[b];
      if (v < nm + 0.4 * ns) continue;
      bool top = true;
      for (int j = std::max(0, b - 8); j <= std::min(n - 1, b + 8); ++j) {
        if (nov[j] > v) {
          top = false;
          break;
        }
      }
      if (!top) continue;
      int cut = b;
      for (const int d : {0, -1, 1, -2, 2}) {
        if (b + d >= 0 && b + d < n && beats[b + d].down) {
          cut = b + d;
          break;
        }
      }
      if (cut - cuts.back() >= 8) cuts.push_back(cut);
    }
    if (n - cuts.back() < 8 && cuts.size() > 1) cuts.pop_back();
    cuts.push_back(n);
    auto timeOf = [&](int b) { return b < n ? beats[b].t : track.duration; };
    for (size_t i = 0; i + 1 < cuts.size(); ++i) {
      Segment seg;
      seg.a = cuts[i];
      seg.z = cuts[i + 1];
      seg.t0 = timeOf(seg.a);
      seg.t1 = timeOf(seg.z);
      double l = 0, lo = 0;
      for (int b = seg.a; b < seg.z; ++b) {
        l += bl[b];
        lo += blow[b];
      }
      seg.loud = l / (seg.z - seg.a);
      seg.low = lo / (seg.z - seg.a);
      track.segments.push_back(seg);
    }
    for (size_t i = 1; i < track.segments.size(); ++i) {
      const auto &p = track.segments[i - 1], &s = track.segments[i];
      const double rise = s.loud / std::max(0.02, p.loud);
      if (rise > 1.2 && s.low > p.low) {
        const int from = std::max(p.a, s.a - 16);
        track.drops.push_back({s.t0, beats[from].t, 4 * 60 / track.bpm, clamp01((rise - 1.1) / 0.6)});
      }
    }
    track.hasStructure = true;
    track.n = n;
    track.mu = mu;
    track.sd = sd;

    // labelSegments: the diagonal between two sections at the best of ±2 beats.
    const double thr = mu + options.repeats * sd;
    std::vector<int> protos;
    auto diag = [&](const Segment &A, const Segment &B) {
      const int len = std::min(A.z - A.a, B.z - B.a);
      double best = -std::numeric_limits<double>::infinity();
      for (int off = -2; off <= 2; ++off) {
        double s = 0;
        int c = 0;
        for (int d = 0; d < len; ++d) {
          const int i = A.a + d, j = B.a + d + off;
          if (j < 0 || j >= n) continue;
          s += S[at(i, j)];
          ++c;
        }
        if (c != 0) best = std::max(best, s / c);
      }
      return best;
    };
    for (size_t i = 0; i < track.segments.size(); ++i) {
      auto &seg = track.segments[i];
      int best = -1;
      double sim = -std::numeric_limits<double>::infinity();
      for (size_t l = 0; l < protos.size(); ++l) {
        const double v = diag(track.segments[protos[l]], seg);
        if (v > sim) {
          sim = v;
          best = static_cast<int>(l);
        }
      }
      if (best >= 0 && sim >= thr) {
        seg.label = best;
        seg.proto = protos[best];
      } else {
        seg.label = static_cast<int>(protos.size());
        seg.proto = static_cast<int>(i);
        protos.push_back(static_cast<int>(i));
      }
    }
    track.labels = static_cast<int>(protos.size());
  }

  // ---- state ---------------------------------------------------------------

  const int sr;
  const int channels;
  const Options options;
  const int hop;
  const double fps;
  const int N, NC;
  const int threads;
  std::vector<double> win, chromaWin;
  std::vector<std::unique_ptr<Workspace>> spaces;
  std::vector<std::thread> running;
  int dispatched = 0;
  double peakBlock = 0;
  std::array<std::array<int, 2>, 3> bands{};
  std::array<int, 13> timbreEdges{};
  int lastBin = 0, chromaLast = 0;
  std::vector<int> pcOf;
  std::vector<float> pcWeight;

  std::vector<float> mono;
  int64_t historyStart = 0;
  double peakMono = 0;
  int64_t received = 0;
  int inHop = 0;
  double hopE = 0, hopEm = 0, hopEs = 0, hopPeak = 0;

  std::array<std::vector<float>, 3> flux;
  std::vector<float> chroma, timbre, rms, peak, mid, side;
};

Analyser::Analyser(int sampleRate, int channels, Options options)
    : impl_(std::make_unique<Impl>(sampleRate, channels, options)) {}
Analyser::~Analyser() = default;
void Analyser::push(const float *interleaved, int frames) { impl_->push(interleaved, frames); }
Track Analyser::finish() { return impl_->finish(); }

}  // namespace cantor::motion
