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

/** The marker in a file's first bytes, or null: Opus now, MP3 and WAV later. */
fun cantorMarker(head: ByteArray): String? =
    if (head.size >= 4 && head[0] == 'O'.code.toByte() && head[1] == 'g'.code.toByte() &&
        head[2] == 'g'.code.toByte() && head[3] == 'S'.code.toByte()) {
      opusCommentInHead(head, CANTOR_MARKER_KEY)
    } else {
      null
    }
