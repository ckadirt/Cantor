package com.cantor.app.audio

import com.facebook.soloader.SoLoader

/**
 * A time range of a song reduced to columns; see `src/main/cpp/AudioReduction.cpp`.
 *
 * The work is in C++ on FFmpeg — the same build react-native-audio-api decodes
 * and plays with — compiled into `libappmodules`. This side only calls it and
 * unpacks the answer.
 */
internal class ReducedWindow(
    val startSeconds: Double,
    val endSeconds: Double,
    val sampleRate: Int,
    val min: Array<FloatArray>,
    val max: Array<FloatArray>,
    val rms: Array<FloatArray>,
    /** RMS of (L+R)/2 and (L−R)/2 per bucket; null for a mono source. */
    val mid: FloatArray?,
    val side: FloatArray?,
)

internal object AudioReduction {
  init {
    // React Native loads it at startup; this makes the dependency explicit and
    // is a no-op when it already has.
    SoLoader.loadLibrary("appmodules")
  }

  /** Throws `IllegalStateException` with FFmpeg's reason when the file cannot be read. */
  fun reduce(path: String, startSeconds: Double, endSeconds: Double, buckets: Int): ReducedWindow {
    val packed = reduceNative(path, startSeconds, endSeconds, buckets)
    val channels = packed[3].toInt()
    check(channels > 0) { "The reduction has no channels." }
    val expected = 4 + buckets * (3 * channels + if (channels >= 2) 2 else 0)
    check(packed.size == expected) { "The reduction has ${packed.size} values, expected $expected." }
    var at = 4
    fun next(): FloatArray = packed.copyOfRange(at, at + buckets).also { at += buckets }
    val min = arrayOfNulls<FloatArray>(channels)
    val max = arrayOfNulls<FloatArray>(channels)
    val rms = arrayOfNulls<FloatArray>(channels)
    for (c in 0 until channels) {
      min[c] = next()
      max[c] = next()
      rms[c] = next()
    }
    val stereo = channels >= 2
    return ReducedWindow(
        packed[0].toDouble(),
        packed[1].toDouble(),
        packed[2].toInt(),
        min.requireNoNulls(),
        max.requireNoNulls(),
        rms.requireNoNulls(),
        if (stereo) next() else null,
        if (stereo) next() else null,
    )
  }

  private external fun reduceNative(
      path: String,
      startSeconds: Double,
      endSeconds: Double,
      buckets: Int,
  ): FloatArray
}
