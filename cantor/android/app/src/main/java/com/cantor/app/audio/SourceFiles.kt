package com.cantor.app.audio

import java.io.File
import java.security.MessageDigest

/**
 * Reading a local file to send it to a node as the source of an audio act: a
 * recorded tune, or a song from the phone's library. Read only. The node
 * decides whether the bytes are audio; this only says how many there are,
 * and what they hash to.
 */
object SourceFiles {
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
}
