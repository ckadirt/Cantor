package com.cantor.app.audio

import android.system.Os
import android.system.OsConstants
import android.util.Base64
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

private const val MAX_CHUNK_BYTES = 64 * 1024

/**
 * How much of a download may be in the page cache before it is forced to disk.
 *
 * Syncing every chunk cost an fsync per 64 KiB — sixty-odd of them for one song,
 * each one a stall on phone flash, and all of it in the critical path between
 * one chunk and the acknowledgement that asks for the next. A partial file is
 * disposable: the worst a power cut can now cost is this much re-downloaded
 * audio, and [finalizeDownload] rejects a torn file by digest before it can ever
 * be promoted or played.
 */
private const val SYNC_INTERVAL_BYTES = 1024 * 1024

private val SHA256 = Regex("^[0-9a-f]{64}$")

internal data class LocalAudioState(
    val state: String,
    val bytes: Double,
)

internal class AudioStorage(
    private val noBackupFilesDir: File,
    private val cacheDir: File,
    private val syncDirectory: (File) -> Unit = ::fsyncDirectory,
) {
  fun localState(nodeKey: String, songId: String, digest: String): LocalAudioState {
    val paths = paths(nodeKey, songId, digest)
    val selected = when {
      paths.pinned.isFile -> "pinned" to paths.pinned
      paths.cached.isFile -> "cached" to paths.cached
      paths.partial.isFile -> "partial" to paths.partial
      else -> "remote" to null
    }
    return LocalAudioState(
        selected.first,
        selected.second?.length()?.toDouble() ?: 0.0,
    )
  }

  fun appendChunk(
      nodeKey: String,
      songId: String,
      digest: String,
      expectedOffset: Double,
      encoded: String,
  ): Double {
    val offset = exactLong(expectedOffset, "expected offset")
    val bytes = Base64.decode(encoded, Base64.DEFAULT)
    require(bytes.isNotEmpty() && bytes.size <= MAX_CHUNK_BYTES) {
      "Artifact chunk is outside the 1–64 KiB bound."
    }
    val path = paths(nodeKey, songId, digest).partial
    path.parentFile?.mkdirs()
    val output = openPartial(path)
    require(output.length() == offset) { "Partial artifact offset changed." }
    output.seek(offset)
    output.write(bytes)
    unsyncedBytes += bytes.size
    if (unsyncedBytes >= SYNC_INTERVAL_BYTES) {
      output.fd.sync()
      unsyncedBytes = 0
    }
    return (offset + bytes.size).toDouble()
  }

  /**
   * The handle the current download is writing through.
   *
   * Reopening the file per chunk was an `open`/`close` pair per 64 KiB for no
   * gain: a download writes one file, sequentially, to the end. Only one
   * transfer is ever in flight — the node keeps a single active transfer per
   * session — so one cached handle is the whole of the bookkeeping, and moving
   * to a different partial closes the previous one.
   *
   * Every caller reaches this under `CantorAudioModule`'s lock, so the handle
   * needs no synchronisation of its own.
   */
  private var openPath: File? = null
  private var openFile: RandomAccessFile? = null
  private var unsyncedBytes = 0

  private fun openPartial(path: File): RandomAccessFile {
    val current = openFile
    if (current != null && openPath == path) return current
    closePartial()
    val opened = RandomAccessFile(path, "rw")
    openPath = path
    openFile = opened
    unsyncedBytes = 0
    return opened
  }

  /**
   * Force the download to disk and release the handle.
   *
   * Called before anything reads the partial as a whole file or moves it, so a
   * rename never races bytes still sitting in this handle's buffer.
   */
  fun closePartial() {
    val current = openFile ?: return
    runCatching {
      if (unsyncedBytes > 0) current.fd.sync()
    }
    runCatching { current.close() }
    openFile = null
    openPath = null
    unsyncedBytes = 0
  }

  fun finalizeDownload(
      nodeKey: String,
      songId: String,
      digest: String,
      expectedBytes: Double,
  ): Boolean {
    val length = exactLong(expectedBytes, "artifact length")
    val paths = paths(nodeKey, songId, digest)
    // The download's own handle still holds unsynced bytes; flush and let it go
    // before the file is hashed and renamed out from under it.
    closePartial()
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
      syncDirectory(paths.cached.parentFile!!)
    }
    paths.cached.setLastModified(System.currentTimeMillis())
    return true
  }

  fun pin(nodeKey: String, songId: String, digest: String): Boolean {
    val paths = paths(nodeKey, songId, digest)
    if (paths.pinned.isFile) return true
    require(paths.cached.isFile && fileSha256(paths.cached) == digest) {
      "Only a verified cached artifact can be pinned."
    }
    paths.pinned.parentFile?.mkdirs()
    check(paths.cached.renameTo(paths.pinned)) { "Could not pin artifact." }
    syncDirectory(paths.pinned.parentFile!!)
    return true
  }

  fun unpin(nodeKey: String, songId: String, digest: String): Boolean {
    val paths = paths(nodeKey, songId, digest)
    if (!paths.pinned.exists()) return true
    require(fileSha256(paths.pinned) == digest) { "Pinned artifact is corrupt." }
    paths.cached.parentFile?.mkdirs()
    check(!paths.cached.exists() || paths.cached.delete()) { "Could not replace cache artifact." }
    check(paths.pinned.renameTo(paths.cached)) { "Could not unpin artifact." }
    syncDirectory(paths.cached.parentFile!!)
    return true
  }

  /**
   * Delete a cached artifact.
   *
   * The caller releases the file first: playback lives in JavaScript now, so
   * native storage has no player to stop and no way to know one is open.
   */
  fun removeCached(nodeKey: String, songId: String, digest: String): Boolean {
    val paths = paths(nodeKey, songId, digest)
    require(!paths.pinned.exists()) { "Unpin this artifact before removing it." }
    // Release the download's handle first: deleting the file underneath an open
    // one leaves the next append writing into an unlinked inode.
    closePartial()
    return (!paths.cached.exists() || paths.cached.delete()) &&
        (!paths.partial.exists() || paths.partial.delete())
  }

  fun playableFile(nodeKey: String, songId: String, digest: String): File {
    val paths = paths(nodeKey, songId, digest)
    val audio = when {
      paths.pinned.isFile -> paths.pinned
      paths.cached.isFile -> paths.cached
      else -> throw IllegalStateException("Download the artifact before playing it.")
    }
    require(fileSha256(audio) == digest) { "Local artifact is corrupt." }
    return audio
  }

  /**
   * Resolve the verified local file the player should load, as an absolute path.
   *
   * Only a cached or pinned artifact is playable; a partial file is never
   * returned, because a partial file is not the song. The last-used time is
   * touched here rather than in [localState] because this is called when
   * playback actually loads, and that is what protects a playing song from
   * cache eviction. Inspecting availability must not make a song look fresh.
   */
  fun localPath(nodeKey: String, songId: String, digest: String): String {
    val audio = playableFile(nodeKey, songId, digest)
    touch(audio)
    return audio.absolutePath
  }

  fun touch(file: File) {
    file.setLastModified(System.currentTimeMillis())
  }

  fun enforceCacheBudget(maxBytes: Double, playingPath: String?): List<String> {
    val budget = exactLong(maxBytes, "cache budget")
    require(budget >= 0) { "Cache budget cannot be negative." }
    val root = File(cacheDir, "cantor-audio/cache")
    val files = root.walkTopDown().filter { it.isFile && it.extension == "opus" }.toList()
    var total = files.sumOf { it.length() }
    val evicted = mutableListOf<String>()
    for (file in files.sortedBy { it.lastModified() }) {
      if (total <= budget) break
      if (file.absolutePath == playingPath) continue
      val bytes = file.length()
      if (file.delete()) {
        total -= bytes
        evicted += file.nameWithoutExtension
      }
    }
    return evicted
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
        File(noBackupFilesDir, "cantor-audio/partial/$relative.part"),
        File(cacheDir, "cantor-audio/cache/$relative"),
        File(noBackupFilesDir, "cantor-audio/pinned/$relative"),
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

  private fun exactLong(value: Double, label: String): Long {
    require(value.isFinite() && value >= 0 && value <= 9_007_199_254_740_991.0) {
      "$label is invalid."
    }
    val integer = value.toLong()
    require(integer.toDouble() == value) { "$label must be an integer." }
    return integer
  }
}

private fun fsyncDirectory(directory: File) {
  val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
  try {
    Os.fsync(descriptor)
  } finally {
    Os.close(descriptor)
  }
}
