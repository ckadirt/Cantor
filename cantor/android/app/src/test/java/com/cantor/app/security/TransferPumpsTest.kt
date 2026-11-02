package com.cantor.app.security

import android.app.Application
import java.util.concurrent.Executor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val CHUNK = 4

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, manifest = Config.NONE, sdk = [35])
class TransferPumpsTest {
  private class Wire : TransferWire {
    val sent = mutableListOf<JSONObject>()
    val inners = mutableListOf<ByteArray>()

    override fun sendControl(json: ByteArray) {
      sent += JSONObject(String(json))
    }

    override fun sendInner(inner: ByteArray) {
      inners += inner.copyOf()
    }

    override fun backlogBytes(): Long = 0
  }

  private class Disk : ArtifactWriter {
    val writes = mutableListOf<Long>()
    var closed = false

    override fun write(offset: Long, data: ByteArray, from: Int, length: Int) {
      writes += offset
    }

    override fun close() {
      closed = true
    }
  }

  /** Runs writes only when told, so a test can hold the disk back. */
  private class HeldWrites : Executor {
    private val queue = ArrayDeque<Runnable>()

    override fun execute(command: Runnable) {
      queue += command
    }

    fun runAll() {
      while (queue.isNotEmpty()) queue.removeFirst().run()
    }
  }

  private inner class Download(val length: Long) {
    val wire = Wire()
    val disk = Disk()
    val writes = HeldWrites()
    var now = 0L
    var done: Throwable? = NOT_DONE
    val pump =
        DownloadPump(
            wire, "xd-1-", "transfer", 2, 0, length, CHUNK, "digest", disk, writes, {}, { done = it },
            { now },
        )

    fun chunk(offset: Long, size: Int = CHUNK) =
        Inner.Chunk("xd-1-0", "transfer", offset, ByteArray(size), 0, size)

    fun complete() =
        JSONObject()
            .put("t", "artifact.complete")
            .put("transfer_id", "transfer")
            .put("byte_length", length)
            .put("sha256", "digest")
  }

  @Test
  fun asksAheadForTheWholeWindowBeforeAnyChunkArrives() {
    val run = Download(CHUNK * 100L)
    run.pump.start()
    assertEquals(16, run.wire.sent.size)
    assertEquals(
        (0 until 16).map { it * CHUNK.toLong() },
        run.wire.sent.map { it.getLong("next_offset") },
    )
  }

  @Test
  fun aChunkHoldsItsSlotUntilItIsOnDisk() {
    val run = Download(CHUNK * 100L)
    run.pump.start()
    run.pump.onChunk(run.chunk(0))
    assertEquals(16, run.wire.sent.size)
    run.writes.runAll()
    assertTrue(run.wire.sent.size > 16)
    assertEquals(listOf(0L), run.disk.writes)
  }

  @Test
  fun finishesOnlyOnceEveryByteIsWrittenAndClosed() {
    val run = Download(CHUNK + 2L)
    run.pump.start()
    assertEquals(listOf(0L, 4L, 6L), run.wire.sent.map { it.getLong("next_offset") })
    run.pump.onChunk(run.chunk(0))
    run.pump.onChunk(run.chunk(4, 2))
    run.pump.onControl(run.complete())
    assertTrue(run.done === NOT_DONE)
    run.writes.runAll()
    assertNull(run.done)
    assertTrue(run.disk.closed)
    assertEquals(listOf(0L, 4L), run.disk.writes)
  }

  @Test
  fun anOutOfOrderChunkEndsTheTransfer() {
    val run = Download(CHUNK * 4L)
    run.pump.start()
    run.pump.onChunk(run.chunk(4))
    run.writes.runAll()
    assertTrue(run.done is IllegalStateException)
  }

  @Test
  fun aNodeRefusalCarriesItsCode() {
    val run = Download(CHUNK * 4L)
    run.pump.start()
    run.pump.onControl(
        JSONObject().put("t", "error").put("code", "transfer_expired").put("message", "again"),
    )
    run.writes.runAll()
    assertEquals("transfer_expired", (run.done as TransferFailure).code)
    assertTrue(run.disk.closed)
  }

  @Test
  fun silencePastTheLimitEndsTheTransfer() {
    val run = Download(CHUNK * 4L)
    run.pump.start()
    run.now = TRANSFER_STALL_MS
    run.pump.checkStalled()
    run.writes.runAll()
    assertEquals("timeout", (run.done as TransferFailure).code)
  }

  private fun upload(wire: Wire, binary: Boolean, done: (Throwable?) -> Unit) =
      UploadPump(
          wire, "xu-1-", "upload", 2, 0, 10, CHUNK, binary,
          object : SourceReader {
            override fun read(offset: Long, into: ByteArray, length: Int) = Unit

            override fun close() = Unit
          },
          {},
          done,
      )

  private fun waitFor(condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + 2_000
    while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(2)
    assertTrue(condition())
  }

  @Test
  fun anUploadSendsAheadAndEndsWhenEverySliceIsAnswered() {
    val wire = Wire()
    var outcome: Throwable? = NOT_DONE
    val pump = upload(wire, binary = true) { outcome = it }
    Thread(pump).start()
    waitFor { wire.inners.size == 3 }
    for (next in listOf(4L, 8L, 10L)) {
      pump.onControl(JSONObject().put("t", "upload.ack").put("next_offset", next))
    }
    waitFor { outcome !== NOT_DONE }
    assertNull(outcome)
  }

  @Test
  fun anOlderNodeGetsJsonSlices() {
    val wire = Wire()
    var outcome: Throwable? = NOT_DONE
    val pump = upload(wire, binary = false) { outcome = it }
    Thread(pump).start()
    waitFor { wire.sent.size == 3 }
    assertEquals("upload.chunk", wire.sent[0].getString("t"))
    pump.onControl(JSONObject().put("t", "error").put("code", "invalid_offset"))
    waitFor { outcome !== NOT_DONE }
    assertEquals("invalid_offset", (outcome as TransferFailure).code)
  }

  private companion object {
    val NOT_DONE = Exception("not done")
  }
}
