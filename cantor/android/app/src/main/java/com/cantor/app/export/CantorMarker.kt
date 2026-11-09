package com.cantor.app.export

/**
 * The tag every file Cantor exports carries, so the device scan can tell one
 * of its own copies from a song of the person's own and never import it as a
 * second song (internal/docs/plans/take-it-plan.md, D5).
 *
 * Its value is written by the JS service (`src/export/marker.ts`) and read
 * back there; this side only stores and finds it. It is the first tag written,
 * so it always lies inside the 64 KiB a scan reads to fingerprint a file.
 */
const val CANTOR_MARKER_KEY = "CANTOR"

/** The marker in a file's first bytes, or null: an Opus comment or an MP3's `TXXX`. */
fun cantorMarker(head: ByteArray): String? =
    when {
      head.startsWith("OggS") -> opusCommentInHead(head, CANTOR_MARKER_KEY)
      head.startsWith("ID3") -> id3TxxxInHead(head, CANTOR_MARKER_KEY)
      else -> null
    }

private fun ByteArray.startsWith(ascii: String): Boolean =
    size >= ascii.length && ascii.indices.all { this[it] == ascii[it].code.toByte() }
