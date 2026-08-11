package com.cantor.app.security

import com.cantor.app.transport.GeneratedTransport.MAX_FRAGMENT_DATA_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_LOGICAL_INNER_BYTES
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The fragment codec needs no Noise state, so its rules are checked directly
 * rather than through a handshake. Robolectric only supplies `org.json` for the
 * shared fixture corpus.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class FragmentCodecTest {
  @Test
  fun sharedFragmentFixtureIsAcceptedAndRejectedRecordByRecord() {
    val fixture = fixture("fragment.json")
    val valid = fixture.getJSONObject("valid").getJSONObject("single_control")
    val record = fromHex(valid.getString("record_hex"))
    assertArrayEquals(
        fromHex(valid.getString("inner_hex")),
        FragmentReassembler().accept(record, record.size),
    )

    val malformed = fixture.getJSONArray("malformed")
    for (index in 0 until malformed.length()) {
      val vector = malformed.getJSONObject(index)
      val bytes = fromHex(vector.getString("record_hex"))
      val reassembler = FragmentReassembler()
      when (val expectation = vector.getString("kotlin")) {
        "reject" ->
            assertThrows(vector.getString("id"), RuntimeException::class.java) {
              reassembler.accept(bytes, bytes.size)
            }
        "accept_partial" -> assertNull(vector.getString("id"), reassembler.accept(bytes, bytes.size))
        else -> error("Unknown Kotlin fixture expectation $expectation")
      }
    }
  }

  @Test
  fun fragmentCountsCoverTheExactSingleAndMultiRecordBoundary() {
    assertThrows(IllegalArgumentException::class.java) { FragmentCodec.fragmentCount(0) }
    assertThrows(IllegalArgumentException::class.java) {
      FragmentCodec.fragmentCount(MAX_LOGICAL_INNER_BYTES + 1)
    }
    assertEquals(1, FragmentCodec.fragmentCount(1))
    assertEquals(1, FragmentCodec.fragmentCount(MAX_FRAGMENT_DATA_BYTES))
    assertEquals(2, FragmentCodec.fragmentCount(MAX_FRAGMENT_DATA_BYTES + 1))
  }

  @Test
  fun reassemblyRequiresOrderedFragmentsOfOneMessageAtATime() {
    val inner = ByteArray(MAX_FRAGMENT_DATA_BYTES + 5) { 9 }
    val count = FragmentCodec.fragmentCount(inner.size)
    assertEquals(2, count)
    val records =
        (0 until count).map { index ->
          val offset = index * MAX_FRAGMENT_DATA_BYTES
          val length = minOf(MAX_FRAGMENT_DATA_BYTES, inner.size - offset)
          FragmentCodec.encodeRecord(0, index, count, inner.size, inner, offset, length)
        }

    val ordered = FragmentReassembler()
    assertNull(ordered.accept(records[0], records[0].size))
    assertArrayEquals(inner, ordered.accept(records[1], records[1].size))

    val outOfOrder = FragmentReassembler()
    assertThrows(RuntimeException::class.java) {
      outOfOrder.accept(records[1], records[1].size)
    }

    val overlapping = FragmentReassembler()
    assertNull(overlapping.accept(records[0], records[0].size))
    assertThrows(RuntimeException::class.java) {
      overlapping.accept(records[0], records[0].size)
    }

    val replayed = FragmentReassembler()
    assertNull(replayed.accept(records[0], records[0].size))
    assertArrayEquals(inner, replayed.accept(records[1], records[1].size))
    assertThrows(RuntimeException::class.java) { replayed.accept(records[0], records[0].size) }
  }

  private fun fixture(name: String): JSONObject {
    var directory: Path? = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
    while (directory != null) {
      val candidate = directory.resolve("protocol/transport/v1/fixtures/$name")
      if (Files.isRegularFile(candidate)) {
        return JSONObject(String(Files.readAllBytes(candidate), Charsets.UTF_8))
      }
      directory = directory.parent
    }
    error("Cannot locate shared transport fixture $name from ${System.getProperty("user.dir")}")
  }

  private fun fromHex(value: String): ByteArray {
    require(value.length % 2 == 0 && value.matches(Regex("^[0-9a-f]*$"))) {
      "Fixture hex is not canonical."
    }
    return ByteArray(value.length / 2) { index ->
      value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }
}
