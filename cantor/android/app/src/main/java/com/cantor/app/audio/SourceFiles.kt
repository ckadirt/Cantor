package com.cantor.app.audio

import android.util.Base64
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * Reading a local file to send it to a node as the source of an audio act: a
 * recorded tune, or a song from the phone's library. Read only. The node
 * decides whether the bytes are audio; this only says how many there are,
 * what they hash to, and hands them over a slice at a time.
 */
object SourceFiles {
  /** A slice larger than this is a caller bug, not a file to read. */
  const val MAX_SLICE_BYTES = 1 shl 20

  data class Info(val bytes: Long, val sha256: String)

  private fun regularFile(path: String): File {
    val file = File(path)
    require(file.isFile && file.canRead()) { "Not a readable file: $path" }
    return file
  }

  fun info(path: String): Info {
    val file = regularFile(path)
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    val hex = digest.digest().joinToString("") { "%02x".format(it) }
    return Info(file.length(), hex)
  }

  /** `length` bytes from `offset`, base64, or fewer at the end of the file. */
  fun slice(path: String, offset: Long, length: Int): String {
    require(offset >= 0) { "Negative offset" }
    require(length in 1..MAX_SLICE_BYTES) { "Slice length out of range" }
    val file = regularFile(path)
    RandomAccessFile(file, "r").use { random ->
      require(offset <= random.length()) { "Offset past the end of the file" }
      random.seek(offset)
      val want = minOf(length.toLong(), random.length() - offset).toInt()
      val bytes = ByteArray(want)
      random.readFully(bytes)
      return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
  }
}
