package com.cantor.app.audio

import android.util.Base64
import com.facebook.soloader.SoLoader
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A song's motion track: beats, onsets, sections and drops, measured by
 * `src/main/cpp/motion/` from the file the player plays.
 *
 * Handed to JS as base64 of the packed little-endian doubles
 * (`MotionTrackJni.cpp` names the layout; `src/lenses/motion/` reads it): a
 * few thousand numbers, which a bridge array of boxed doubles would carry ten
 * times slower.
 */
internal object MotionTrack {
  init {
    SoLoader.loadLibrary("appmodules")
  }

  /** Throws `IllegalStateException` with the decoder's reason when the file cannot be read. */
  fun measure(path: String): String {
    val packed = measureNative(path)
    val bytes = ByteBuffer.allocate(packed.size * 8).order(ByteOrder.LITTLE_ENDIAN)
    bytes.asDoubleBuffer().put(packed)
    return Base64.encodeToString(bytes.array(), Base64.NO_WRAP)
  }

  private external fun measureNative(path: String): DoubleArray
}
