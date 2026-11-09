package com.cantor.app.export

import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Id3v2Test {
  private val marker = "v1;24b2e848841847b205bd273d3cdfc255;ca0181f2-9a70-86d0-93d3-b739f44cb826;" + "e".repeat(64)

  /** Frame ids and bodies, read back with the 2.4 rules. */
  private fun frames(tag: ByteArray): List<Pair<String, ByteArray>> {
    fun size(at: Int) = ((tag[at].toInt() and 0x7f) shl 21) or ((tag[at + 1].toInt() and 0x7f) shl 14) or
        ((tag[at + 2].toInt() and 0x7f) shl 7) or (tag[at + 3].toInt() and 0x7f)
    val end = 10 + size(6)
    assertEquals("the header's size is the whole tag after it", tag.size, end)
    val out = ArrayList<Pair<String, ByteArray>>()
    var at = 10
    while (at < end) {
      val body = size(at + 4)
      out += String(tag, at, 4, Charsets.ISO_8859_1) to tag.copyOfRange(at + 10, at + 10 + body)
      at += 10 + body
    }
    return out
  }

  @Test
  fun writesEachTagAsTheFramePlayersRead() {
    val tag = id3v2Tag(
        listOf(
            "CANTOR" to marker,
            "TITLE" to "Variation of Wild Ride",
            "ALBUM" to "Cantor",
            "LYRICS" to "It's been a wild ride\nñandú",
            "DESCRIPTION" to "A melancholic French pop track",
        ),
        cover = byteArrayOf(1, 2, 3),
    )
    assertArrayEquals(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), 4, 0, 0), tag.copyOf(6))
    val frames = frames(tag)
    assertEquals(listOf("TXXX", "TIT2", "TALB", "USLT", "COMM", "APIC"), frames.map { it.first })
    assertEquals("\u0003CANTOR\u0000$marker", String(frames[0].second, Charsets.UTF_8))
    assertEquals("\u0003Variation of Wild Ride", String(frames[1].second, Charsets.UTF_8))
    assertEquals("\u0003XXX\u0000It's been a wild ride\nñandú", String(frames[3].second, Charsets.UTF_8))
    val apic = frames[5].second
    assertEquals("\u0003image/png\u0000\u0003\u0000", String(apic, 0, apic.size - 3, Charsets.ISO_8859_1))
    assertArrayEquals(byteArrayOf(1, 2, 3), apic.copyOfRange(apic.size - 3, apic.size))
  }

  @Test
  fun theMarkerIsFoundInTheHeadOfAnMp3WithALargeCover() {
    val cover = Random(5).nextBytes(300_000)
    val tag = id3v2Tag(listOf("CANTOR" to marker, "TITLE" to "Lanterns"), cover)
    val file = tag + ByteArray(5000) { 0xFF.toByte() }
    assertTrue(tag.size > 64 * 1024)
    assertEquals(marker, cantorMarker(file.copyOf(64 * 1024)))
  }

  @Test
  fun readsAVersion23TagToo() {
    // A 2.3 frame's size is a plain 32-bit number.
    val body = byteArrayOf(0) + "CANTOR".toByteArray() + byteArrayOf(0) + marker.toByteArray()
    val frame = "TXXX".toByteArray() + byteArrayOf(0, 0, 0, body.size.toByte()) + byteArrayOf(0, 0) + body
    // The header's own size is syncsafe in every version.
    val head = byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), 3, 0, 0, 0, 0,
        (frame.size ushr 7).toByte(), (frame.size and 0x7f).toByte())
    assertEquals(marker, cantorMarker(head + frame))
  }

  @Test
  fun findsNothingThatIsNotAMarker() {
    assertNull(cantorMarker(id3v2Tag(listOf("TITLE" to "Lanterns", "OTHER" to "x"))))
    assertNull(cantorMarker(id3v2Tag(listOf("CANTORX" to marker))))
    assertNull(cantorMarker("ID3".toByteArray()))
    // A marker beyond the head is not read.
    val late = id3v2Tag(listOf("COMMENT" to "c".repeat(70_000), "CANTOR" to marker))
    assertNull(cantorMarker(late.copyOf(64 * 1024)))
    // An unsynchronised tag is left alone rather than misread.
    val tag = id3v2Tag(listOf("CANTOR" to marker))
    tag[5] = 0x80.toByte()
    assertNull(cantorMarker(tag))
  }
}
