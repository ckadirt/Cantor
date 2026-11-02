package com.cantor.app.security

import android.util.Base64
import java.io.Closeable
import java.util.concurrent.Executor
import org.json.JSONObject

/** Silence this long ends a transfer; it is the app's request timeout. */
internal const val TRANSFER_STALL_MS = 15_000L
private const val PROGRESS_SAMPLE_MS = 400L
/** Slices queued in the socket itself, beyond which an upload waits. */
private const val SOCKET_BACKLOG_BYTES = 1L shl 20

/** Thrown to a transfer's promise; [code] is the node's error code. */
internal class TransferFailure(val code: String, message: String) : Exception(message)

/** What the pumps need of a secure connection. */
internal interface TransferWire {
  fun sendControl(json: ByteArray)

  /** Encrypts and sends an inner frame already laid out. */
  fun sendInner(inner: ByteArray)

  /** Bytes accepted but not yet written to the socket. */
  fun backlogBytes(): Long
}

/** Where a download's bytes go. Calls arrive in order, on the writer. */
internal interface ArtifactWriter {
  fun write(offset: Long, data: ByteArray, from: Int, length: Int)

  fun close()
}

/** A transfer the socket's reader can hand frames to. */
internal interface TransferPump {
  fun onChunk(chunk: Inner.Chunk)

  fun onControl(message: JSONObject)

  fun fail(failure: Throwable)

  /** Ends the transfer if it has been silent past the limit. */
  fun checkStalled()
}

/**
 * Pulls a delivery artifact straight to disk, with no byte crossing into JS.
 *
 * Acknowledgements go ahead of the chunks they answer: the node serves each one
 * as it arrives, one for one, in order. A chunk holds its window slot until it
 * is written, so a phone slower than its connection slows the node down rather
 * than queueing audio in memory.
 */
internal class DownloadPump(
    private val wire: TransferWire,
    private val requestPrefix: String,
    private val transferId: String,
    private val protocolVersion: Int,
    start: Long,
    private val byteLength: Long,
    private val chunkBytes: Int,
    private val sha256: String,
    private val writer: ArtifactWriter,
    private val writes: Executor,
    private val onProgress: (Long) -> Unit,
    private val onDone: (Throwable?) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) : TransferPump {
  private val pace = TransferPace(chunkBytes, now)
  private var asked = start
  private var askedLast = false
  private var received = start
  private var written = start
  private var unsettled = 0
  private var sequence = 0
  private var completed = false
  private var finished = false
  private var lastActivity = now()
  private var lastProgress = 0L

  @Synchronized
  fun start() {
    askAhead()
  }

  private fun askAhead() {
    while (!finished && !askedLast && unsettled < pace.window) {
      unsettled += 1
      val id = "$requestPrefix${sequence++}"
      wire.sendControl(
          ("{\"t\":\"artifact.ack\",\"v\":$protocolVersion,\"id\":\"$id\"," +
              "\"transfer_id\":${JSONObject.quote(transferId)},\"next_offset\":$asked}")
              .toByteArray(),
      )
      askedLast = asked == byteLength
      asked = minOf(asked + chunkBytes, byteLength)
    }
  }

  @Synchronized
  override fun onChunk(chunk: Inner.Chunk) {
    if (finished) return
    lastActivity = now()
    val next = received + chunk.length
    if (
        chunk.transferId != transferId ||
            chunk.offset != received ||
            next != minOf(received + chunkBytes, byteLength)
    ) {
      fail(IllegalStateException("Node artifact chunk is out of order."))
      return
    }
    received = next
    writes.execute {
      try {
        writer.write(chunk.offset, chunk.data, chunk.from, chunk.length)
        chunk.data.fill(0)
        settled(chunk.length, next)
      } catch (error: Throwable) {
        fail(error)
      }
    }
  }

  @Synchronized
  private fun settled(length: Int, end: Long) {
    if (finished) return
    written = end
    unsettled -= 1
    pace.settled(length)
    val at = now()
    if (at - lastProgress >= PROGRESS_SAMPLE_MS) {
      lastProgress = at
      onProgress(written)
    }
    if (completed && written == byteLength) finish(null) else askAhead()
  }

  @Synchronized
  override fun onControl(message: JSONObject) {
    if (finished) return
    lastActivity = now()
    when (message.optString("t")) {
      "artifact.complete" -> {
        if (
            message.optString("transfer_id") != transferId ||
                message.optLong("byte_length", -1) != byteLength ||
                message.optString("sha256") != sha256 ||
                received != byteLength
        ) {
          fail(IllegalStateException("Node artifact completion does not match the download."))
          return
        }
        completed = true
        if (written == byteLength) finish(null)
      }
      "error" ->
          fail(TransferFailure(message.optString("code", "internal"), message.optString("message")))
    }
  }

  @Synchronized
  override fun fail(failure: Throwable) {
    finish(failure)
  }

  @Synchronized
  override fun checkStalled() {
    if (!finished && now() - lastActivity >= TRANSFER_STALL_MS) {
      fail(TransferFailure("timeout", "Audio transfer timed out. It is safe to retry."))
    }
  }

  private fun finish(failure: Throwable?) {
    if (finished) return
    finished = true
    // Behind any write still queued: the partial must be whole before anyone
    // reads it, resumes from it, or renames it.
    writes.execute {
      val closing = runCatching { writer.close() }.exceptionOrNull()
      onDone(failure ?: closing)
    }
  }
}

/** Reads a source file for an upload, one slice at a time. */
internal interface SourceReader : Closeable {
  fun read(offset: Long, into: ByteArray, length: Int)
}

/**
 * Sends a file to a node from its own thread: reads, frames, and encrypts each
 * slice, ahead of its answer. The node takes slices in the order they were sent,
 * and refuses everything after a wrong offset, so the first refusal ends the run
 * and JS asks the node where it stands.
 */
internal class UploadPump(
    private val wire: TransferWire,
    private val requestPrefix: String,
    private val uploadId: String,
    private val protocolVersion: Int,
    private val start: Long,
    private val byteLength: Long,
    private val chunkBytes: Int,
    private val binary: Boolean,
    private val source: SourceReader,
    private val onProgress: (Long) -> Unit,
    private val onDone: (Throwable?) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) : TransferPump, Runnable {
  private val lock = Object()
  private val pace = TransferPace(chunkBytes, now)
  private var acknowledged = start
  private var outstanding = 0
  private var sequence = 0
  private var failure: Throwable? = null
  private var lastActivity = now()
  private var lastProgress = 0L

  override fun run() {
    val result =
        runCatching {
              var sent = start
              val slice = ByteArray(chunkBytes)
              while (sent < byteLength) {
                awaitRoom()
                val length = minOf(chunkBytes.toLong(), byteLength - sent).toInt()
                source.read(sent, slice, length)
                sendSlice(sent, slice, length)
                sent += length
              }
              awaitAllAnswered()
            }
            .exceptionOrNull()
    runCatching { source.close() }
    onDone(result)
  }

  private fun sendSlice(offset: Long, slice: ByteArray, length: Int) {
    val id = synchronized(lock) { "$requestPrefix${sequence++}" }
    if (binary) {
      val inner = InnerCodec.encodeUploadChunk(id, uploadId, offset, slice, length)
      wire.sendInner(inner)
      inner.fill(0)
      return
    }
    val data = Base64.encodeToString(slice, 0, length, Base64.NO_WRAP)
    wire.sendControl(
        ("{\"t\":\"upload.chunk\",\"v\":$protocolVersion,\"id\":\"$id\"," +
            "\"upload_id\":${JSONObject.quote(uploadId)},\"offset\":$offset,\"data\":\"$data\"}")
            .toByteArray(),
    )
  }

  private fun awaitRoom() {
    synchronized(lock) {
      while (true) {
        failure?.let { throw it }
        if (outstanding < pace.window && wire.backlogBytes() < SOCKET_BACKLOG_BYTES) {
          outstanding += 1
          return
        }
        lock.wait(WAIT_MS)
      }
    }
  }

  private fun awaitAllAnswered() {
    synchronized(lock) {
      while (true) {
        failure?.let { throw it }
        if (acknowledged == byteLength) return
        lock.wait(WAIT_MS)
      }
    }
  }

  override fun onChunk(chunk: Inner.Chunk) = Unit

  override fun onControl(message: JSONObject) {
    synchronized(lock) {
      if (failure != null) return
      lastActivity = now()
      when (message.optString("t")) {
        "upload.ack" -> {
          val next = message.optLong("next_offset", -1)
          val length = next - acknowledged
          if (length <= 0 || length > chunkBytes) {
            fail(IllegalStateException("Node acknowledged the wrong upload offset."))
            return
          }
          acknowledged = next
          outstanding -= 1
          pace.settled(length.toInt())
          val at = now()
          if (at - lastProgress >= PROGRESS_SAMPLE_MS) {
            lastProgress = at
            onProgress(next)
          }
          lock.notifyAll()
        }
        "error" ->
            fail(
                TransferFailure(message.optString("code", "internal"), message.optString("message")),
            )
      }
    }
  }

  override fun fail(failure: Throwable) {
    synchronized(lock) {
      if (this.failure == null) this.failure = failure
      lock.notifyAll()
    }
  }

  override fun checkStalled() {
    synchronized(lock) {
      if (now() - lastActivity >= TRANSFER_STALL_MS) {
        fail(TransferFailure("timeout", "Sending timed out. It is safe to retry."))
      }
    }
  }

  private companion object {
    const val WAIT_MS = 50L
  }
}
