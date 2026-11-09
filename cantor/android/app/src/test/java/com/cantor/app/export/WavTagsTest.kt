package com.cantor.app.export

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class WavTagsTest {
  private val marker = "v1;24b2e848841847b205bd273d3cdfc255;ca0181f2-9a70-86d0-93d3-b739f44cb826;" + "e".repeat(64)

  /** A canonical 44-byte-header WAV, as the node's `complete` writes its master. */
  private fun master(frames: Int = 480): ByteArray {
    val data = frames * 4
    val out = ByteArrayOutputStream()
    fun u32(v: Int) { for (i in 0 until 4) out.write(v ushr (8 * i) and 0xff) }
    fun u16(v: Int) { out.write(v and 0xff); out.write(v ushr 8 and 0xff) }
    out.write("RIFF".toByteArray()); u32(36 + data); out.write("WAVEfmt ".toByteArray())
    u32(16); u16(1); u16(2); u32(48_000); u32(192_000); u16(4); u16(16)
    out.write("data".toByteArray()); u32(data)
    repeat(data) { out.write(it % 251) }
    return out.toByteArray()
  }

  private fun tag(wav: ByteArray, tags: List<Pair<String, String>>): ByteArray {
    val out = ByteArrayOutputStream()
    tagWav(ByteArrayInputStream(wav), out, tags)
    return out.toByteArray()
  }

  /** The chunk ids and bodies after `WAVE`, with the RIFF size checked. */
  private fun chunks(wav: ByteArray): List<Pair<String, ByteArray>> {
    fun le32(at: Int) = (wav[at].toInt() and 0xff) or ((wav[at + 1].toInt() and 0xff) shl 8) or
        ((wav[at + 2].toInt() and 0xff) shl 16) or ((wav[at + 3].toInt() and 0xff) shl 24)
    assertEquals("the RIFF size is everything after it", wav.size - 8, le32(4))
    val out = ArrayList<Pair<String, ByteArray>>()
    var at = 12
    while (at < wav.size) {
      val size = le32(at + 4)
      out += String(wav, at, 4, Charsets.US_ASCII) to wav.copyOfRange(at + 8, at + 8 + size)
      at += 8 + size + (size and 1)
    }
    return out
  }

  @Test
  fun tagsGoBetweenTheFormatAndTheAudioWhichIsUntouched() {
    val source = master()
    val tagged = tag(
        source,
        listOf("CANTOR" to marker, "TITLE" to "Wild Ride", "ALBUM" to "Cantor", "LYRICS" to "words", "DESCRIPTION" to "a"),
    )
    val chunks = chunks(tagged)
    assertEquals(listOf("fmt ", "cntr", "LIST", "data"), chunks.map { it.first })
    assertEquals(marker, String(chunks[1].second, Charsets.UTF_8))
    val list = String(chunks[2].second, Charsets.US_ASCII)
    assert(list.startsWith("INFO")) { list }
    assert(list.contains("INAM") && list.contains("Wild Ride\u0000")) { list }
    assert(list.contains("IPRD") && list.contains("ICMT")) { list }
    assert(!list.contains("words")) { "lyrics have no INFO field" }
    // The audio, and the format, byte for byte.
    assertArrayEquals(source.copyOfRange(44, source.size), chunks[3].second)
    assertArrayEquals(source.copyOfRange(12, 36), tagged.copyOfRange(12, 36))
  }

  @Test
  fun anOddLengthTagIsPaddedSoTheNextChunkStaysAligned() {
    val tagged = tag(master(), listOf("CANTOR" to "odd", "TITLE" to "ab"))
    assertEquals(listOf("fmt ", "cntr", "LIST", "data"), chunks(tagged).map { it.first })
    assertEquals("odd", cantorMarker(tagged))
  }

  @Test
  fun theScanFindsTheMarkerInItsHead() {
    val tagged = tag(master(frames = 48_000), listOf("CANTOR" to marker, "TITLE" to "t"))
    assertEquals(marker, cantorMarker(tagged.copyOf(64 * 1024)))
    assertNull(cantorMarker(master()))
    assertNull(cantorMarker("RIFF".toByteArray()))
  }

  @Test
  fun refusesWhatIsNotAWav() {
    assertThrows(IllegalArgumentException::class.java) { tag("OggS0000WAVE".toByteArray() + ByteArray(40), emptyList()) }
    val noFormat = master().also { "LIST".toByteArray().copyInto(it, 12) }
    assertThrows(IllegalArgumentException::class.java) { tag(noFormat, emptyList()) }
  }
}
