package com.cantor.app.security

import java.nio.file.Files
import java.nio.file.Paths
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, manifest = Config.NONE, sdk = [35])
class InnerCodecTest {
  private val valid =
      JSONObject(
              String(
                  Files.readAllBytes(
                      generateSequence(Paths.get("").toAbsolutePath()) { it.parent }
                          .map { it.resolve("protocol/transport/v1/fixtures/inner.json") }
                          .first { Files.exists(it) },
                  ),
              ),
          )
          .getJSONObject("valid")

  private fun hex(value: String): ByteArray =
      value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  @Test
  fun controlMatchesTheSharedVectorBothWays() {
    val vector = valid.getJSONObject("control")
    val frame = hex(vector.getString("frame_hex"))
    assertArrayEquals(frame, InnerCodec.encodeControl(vector.getString("json").toByteArray()))
    assertEquals(Inner.Control(vector.getString("json")), InnerCodec.decodeNode(frame))
  }

  @Test
  fun artifactChunkReadsTheSharedVector() {
    val vector = valid.getJSONObject("artifact")
    val chunk = InnerCodec.decodeNode(hex(vector.getString("frame_hex"))) as Inner.Chunk
    assertEquals(vector.getString("request_id"), chunk.requestId)
    assertEquals(vector.getString("transfer_id"), chunk.transferId)
    assertEquals(vector.getLong("offset"), chunk.offset)
    assertArrayEquals(
        hex(vector.getString("data_hex")),
        chunk.data.copyOfRange(chunk.from, chunk.from + chunk.length),
    )
  }

  @Test
  fun uploadChunkWritesTheSharedVector() {
    val vector = valid.getJSONObject("upload")
    val data = hex(vector.getString("data_hex"))
    assertArrayEquals(
        hex(vector.getString("frame_hex")),
        InnerCodec.encodeUploadChunk(
            vector.getString("request_id"),
            vector.getString("upload_id"),
            vector.getLong("offset"),
            data + ByteArray(8),
            data.size,
        ),
    )
  }

  @Test
  fun carrierRoundTripsAndRefusesAChangedLength() {
    val frame = InnerCodec.encodeCarrier(byteArrayOf(1, 2, 3))
    assertEquals(3, InnerCodec.carrierLength(frame))
    assertThrows(IllegalArgumentException::class.java) {
      InnerCodec.carrierLength(frame + 0)
    }
  }

  @Test
  fun aTruncatedChunkIsRefused() {
    val frame = hex(valid.getJSONObject("artifact").getString("frame_hex"))
    assertThrows(RuntimeException::class.java) {
      InnerCodec.decodeNode(frame.copyOf(frame.size - 1))
    }
    assertTrue(frame.size > 2)
  }
}
