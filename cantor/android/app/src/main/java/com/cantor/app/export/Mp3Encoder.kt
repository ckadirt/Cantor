package com.cantor.app.export

import com.facebook.soloader.SoLoader

/** What an encode did, for the log and the knobs. */
internal class Mp3Encoded(
    val segments: Int,
    val frames: Long,
    val bytes: Long,
    val sampleRate: Int,
    val milliseconds: Double,
)

/**
 * A song's audio as raw MP3 frames, made by LAME on several cores at once
 * (`cpp/export/Mp3Encode.h`). The tag is written around them by
 * `CantorExportModule`.
 */
internal object Mp3Encoder {
  /** KNOBS — measured 2026-11-09 (internal/docs/plans/take-it-log.md, E2). */
  /** Constant bitrate: the most MP3 has; 160k Opus into it is transparent. */
  const val KBPS = 320
  /** LAME's default quality: q2 doubles the time for nothing heard at 320k. */
  const val QUALITY = 3
  /** Segments at once: 1.5 s for 3 minutes on the Xiaomi, 0.8 s on the A52s. */
  const val SEGMENTS = 4

  init {
    SoLoader.loadLibrary("appmodules")
  }

  fun encode(source: String, target: String): Mp3Encoded {
    val values = encodeNative(source, target, KBPS, QUALITY, SEGMENTS)
    return Mp3Encoded(
        segments = values[0].toInt(),
        frames = values[1].toLong(),
        bytes = values[2].toLong(),
        sampleRate = values[3].toInt(),
        milliseconds = values[4],
    )
  }

  private external fun encodeNative(
      source: String,
      target: String,
      kbps: Int,
      quality: Int,
      segments: Int,
  ): DoubleArray
}
