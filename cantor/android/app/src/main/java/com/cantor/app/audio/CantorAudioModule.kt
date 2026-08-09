package com.cantor.app.audio

import android.media.MediaPlayer
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

private const val MODULE_NAME = "CantorAudio"
private const val MAX_CHUNK_BYTES = 64 * 1024
private val SHA256 = Regex("^[0-9a-f]{64}$")

class CantorAudioModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private var player: MediaPlayer? = null
  private var playingPath: String? = null

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun localState(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val paths = paths(nodeKey, songId, digest)
        val selected = when {
          paths.pinned.isFile -> "pinned" to paths.pinned
          paths.cached.isFile -> "cached" to paths.cached
          paths.partial.isFile -> "partial" to paths.partial
          else -> "remote" to null
        }
        WritableNativeMap().apply {
          putString("state", selected.first)
          putDouble("bytes", selected.second?.length()?.toDouble() ?: 0.0)
        }
      }
    }
  }

  @ReactMethod
  fun appendChunk(
      nodeKey: String,
      songId: String,
      digest: String,
      expectedOffset: Double,
      encoded: String,
      promise: Promise,
  ) {
    runPromise(promise) {
      synchronized(lock) {
        val offset = exactLong(expectedOffset, "expected offset")
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        require(bytes.isNotEmpty() && bytes.size <= MAX_CHUNK_BYTES) {
          "Artifact chunk is outside the 1–64 KiB bound."
        }
        val path = paths(nodeKey, songId, digest).partial
        path.parentFile?.mkdirs()
        RandomAccessFile(path, "rw").use { output ->
          require(output.length() == offset) { "Partial artifact offset changed." }
          output.seek(offset)
          output.write(bytes)
          output.fd.sync()
        }
        (offset + bytes.size).toDouble()
      }
    }
  }

  @ReactMethod
  fun finalizeDownload(
      nodeKey: String,
      songId: String,
      digest: String,
      expectedBytes: Double,
      promise: Promise,
  ) {
    runPromise(promise) {
      synchronized(lock) {
        val length = exactLong(expectedBytes, "artifact length")
        val paths = paths(nodeKey, songId, digest)
        require(paths.partial.isFile && paths.partial.length() == length) {
          "Partial artifact length does not match the node."
        }
        if (fileSha256(paths.partial) != digest) {
          check(paths.partial.delete()) { "Downloaded artifact is corrupt and could not be removed." }
          throw IllegalStateException("Downloaded artifact digest does not match the node.")
        }
        paths.cached.parentFile?.mkdirs()
        if (paths.cached.exists()) {
          require(fileSha256(paths.cached) == digest) { "Cached artifact is corrupt." }
          check(paths.partial.delete()) { "Could not discard duplicate partial artifact." }
        } else {
          check(paths.partial.renameTo(paths.cached)) { "Could not atomically promote artifact." }
          fsyncDirectory(paths.cached.parentFile!!)
        }
        paths.cached.setLastModified(System.currentTimeMillis())
        true
      }
    }
  }

  @ReactMethod
  fun pin(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val paths = paths(nodeKey, songId, digest)
        if (paths.pinned.isFile) return@synchronized true
        require(paths.cached.isFile && fileSha256(paths.cached) == digest) {
          "Only a verified cached artifact can be pinned."
        }
        paths.pinned.parentFile?.mkdirs()
        check(paths.cached.renameTo(paths.pinned)) { "Could not pin artifact." }
        fsyncDirectory(paths.pinned.parentFile!!)
        true
      }
    }
  }

  @ReactMethod
  fun unpin(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val paths = paths(nodeKey, songId, digest)
        if (!paths.pinned.exists()) return@synchronized true
        require(fileSha256(paths.pinned) == digest) { "Pinned artifact is corrupt." }
        paths.cached.parentFile?.mkdirs()
        check(!paths.cached.exists() || paths.cached.delete()) { "Could not replace cache artifact." }
        check(paths.pinned.renameTo(paths.cached)) { "Could not unpin artifact." }
        fsyncDirectory(paths.cached.parentFile!!)
        true
      }
    }
  }

  @ReactMethod
  fun removeCached(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val paths = paths(nodeKey, songId, digest)
        require(!paths.pinned.exists()) { "Unpin this artifact before removing it." }
        if (playingPath == paths.cached.absolutePath) stopPlayer()
        (!paths.cached.exists() || paths.cached.delete()) &&
            (!paths.partial.exists() || paths.partial.delete())
      }
    }
  }

  @ReactMethod
  fun play(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val paths = paths(nodeKey, songId, digest)
        val audio = when {
          paths.pinned.isFile -> paths.pinned
          paths.cached.isFile -> paths.cached
          else -> throw IllegalStateException("Download the artifact before playing it.")
        }
        require(fileSha256(audio) == digest) { "Local artifact is corrupt." }
        stopPlayer()
        val next = MediaPlayer()
        next.setDataSource(audio.absolutePath)
        next.setOnCompletionListener {
          synchronized(lock) {
            if (player === it) {
              it.release()
              player = null
              playingPath = null
            }
          }
        }
        next.prepare()
        next.start()
        player = next
        playingPath = audio.absolutePath
        audio.setLastModified(System.currentTimeMillis())
        true
      }
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        stopPlayer()
        true
      }
    }
  }

  @ReactMethod
  fun enforceCacheBudget(maxBytes: Double, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val budget = exactLong(maxBytes, "cache budget")
        require(budget >= 0) { "Cache budget cannot be negative." }
        val root = File(reactApplicationContext.cacheDir, "cantor-audio/cache")
        val files = root.walkTopDown().filter { it.isFile && it.extension == "opus" }.toList()
        var total = files.sumOf { it.length() }
        val evicted = WritableNativeArray()
        for (file in files.sortedBy { it.lastModified() }) {
          if (total <= budget) break
          if (file.absolutePath == playingPath) continue
          val bytes = file.length()
          if (file.delete()) {
            total -= bytes
            evicted.pushString(file.nameWithoutExtension)
          }
        }
        evicted
      }
    }
  }

  override fun invalidate() {
    synchronized(lock) { stopPlayer() }
    super.invalidate()
  }

  private fun stopPlayer() {
    player?.runCatching { stop() }
    player?.release()
    player = null
    playingPath = null
  }

  private data class AudioPaths(
      val partial: File,
      val cached: File,
      val pinned: File,
  )

  private fun paths(nodeKey: String, songId: String, digest: String): AudioPaths {
    require(runCatching { UUID.fromString(songId) }.isSuccess) { "Song id is invalid." }
    require(SHA256.matches(digest)) { "Artifact digest is invalid." }
    val node = MessageDigest.getInstance("SHA-256")
        .digest(nodeKey.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
    val relative = "$node/$songId/$digest.opus"
    return AudioPaths(
        File(reactApplicationContext.noBackupFilesDir, "cantor-audio/partial/$relative.part"),
        File(reactApplicationContext.cacheDir, "cantor-audio/cache/$relative"),
        File(reactApplicationContext.noBackupFilesDir, "cantor-audio/pinned/$relative"),
    )
  }

  private fun fileSha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun fsyncDirectory(directory: File) {
    val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
    try {
      Os.fsync(descriptor)
    } finally {
      Os.close(descriptor)
    }
  }

  private fun exactLong(value: Double, label: String): Long {
    require(value.isFinite() && value >= 0 && value <= 9_007_199_254_740_991.0) {
      "$label is invalid."
    }
    val integer = value.toLong()
    require(integer.toDouble() == value) { "$label must be an integer." }
    return integer
  }

  private inline fun runPromise(promise: Promise, operation: () -> Any?) {
    try {
      promise.resolve(operation())
    } catch (error: Throwable) {
      promise.reject("E_CANTOR_AUDIO", error.message ?: "Audio operation failed.", error)
    }
  }
}
