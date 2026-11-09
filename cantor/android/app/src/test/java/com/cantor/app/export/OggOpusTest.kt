package com.cantor.app.export

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OggOpusTest {
  private val serial = 0x1234abcd

  /** A small Ogg Opus stream: head, tags, then audio pages of opaque packets. */
  private fun stream(tags: List<String> = listOf("ENCODER=cantor-node", "TITLE=old")): Pair<ByteArray, List<OggPage>> {
    val out = ByteArrayOutputStream()
    val head = ByteArray(19).also { "OpusHead".toByteArray().copyInto(it) }
    page(out, 0x02, 0, 0, listOf(head))
    page(out, 0, 0, 1, listOf(tagsPacket("libopus 1.4", tags)))
    val random = Random(7)
    val audio = (0 until 4).map { index ->
      val packets = List(3) { ByteArray(random.nextInt(40, 400)) { random.nextInt().toByte() } }
      page(out, if (index == 3) 0x04 else 0, 960L * 3 * (index + 1), 2 + index, packets)
      packets
    }
    val pages = readAll(out.toByteArray())
    return out.toByteArray() to pages.drop(2).also { assertEquals(audio.size, it.size) }
  }

  private fun tagsPacket(vendor: String, comments: List<String>): ByteArray {
    val out = ByteArrayOutputStream()
    fun u32(v: Int) { for (i in 0 until 4) out.write(v ushr (8 * i) and 0xff) }
    out.write("OpusTags".toByteArray())
    vendor.toByteArray().let { u32(it.size); out.write(it) }
    u32(comments.size)
    comments.forEach { c -> c.toByteArray().let { u32(it.size); out.write(it) } }
    return out.toByteArray()
  }

  private fun page(out: ByteArrayOutputStream, type: Int, granule: Long, sequence: Int, packets: List<ByteArray>) {
    val lacing = ArrayList<Int>()
    packets.forEach { p ->
      var left = p.size
      while (left >= 255) { lacing += 255; left -= 255 }
      lacing += left
    }
    val body = packets.fold(ByteArray(0)) { a, b -> a + b }
    OggPage(type, granule, serial, sequence, ByteArray(lacing.size) { lacing[it].toByte() }, body).write(out)
  }

  private fun readAll(bytes: ByteArray): List<OggPage> {
    val input = ByteArrayInputStream(bytes)
    return generateSequence { readPage(input) }.toList()
  }

  private fun rewrite(source: ByteArray, comments: List<Pair<String, String>>, picture: ByteArray? = null): ByteArray {
    val out = ByteArrayOutputStream()
    rewriteOpusTags(ByteArrayInputStream(source), out, comments, picture)
    return out.toByteArray()
  }

  /** Every page's checksum, recomputed with its own field zeroed. */
  private fun assertChecksums(bytes: ByteArray) {
    var at = 0
    while (at < bytes.size) {
      val segments = bytes[at + 26].toInt() and 0xff
      val bodyBytes = (0 until segments).sumOf { bytes[at + 27 + it].toInt() and 0xff }
      val length = 27 + segments + bodyBytes
      val page = bytes.copyOfRange(at, at + length)
      val stored = page.copyOfRange(22, 26)
      for (i in 22 until 26) page[i] = 0
      val crc = oggCrc(0, page)
      assertArrayEquals(ByteArray(4) { (crc ushr (8 * it)).toByte() }, stored)
      at += length
    }
  }

  private fun tagsOf(pages: List<OggPage>): OpusTags {
    val packet = ByteArrayOutputStream()
    for (page in pages.drop(1)) {
      packet.write(page.body)
      if (page.endsPacket) break
    }
    return parseOpusTags(packet.toByteArray())
  }

  @Test
  fun replacesTheTagsAndCopiesTheAudio() {
    val (source, audio) = stream()
    val output = rewrite(source, listOf("CANTOR" to "v1;n;s;d", "TITLE" to "Lanterns", "ALBUM" to "Cantor"))
    assertChecksums(output)
    val pages = readAll(output)
    assertEquals((0 until pages.size).toList(), pages.map { it.sequence })
    val tags = tagsOf(pages)
    assertEquals("libopus 1.4", tags.vendor)
    // Ours first, in order; the encoder's own note kept; the old title gone.
    assertEquals(listOf("CANTOR=v1;n;s;d", "TITLE=Lanterns", "ALBUM=Cantor", "ENCODER=cantor-node"), tags.comments)
    val copied = pages.drop(2)
    assertEquals(audio.size, copied.size)
    audio.zip(copied).forEach { (before, after) ->
      assertArrayEquals(before.body, after.body)
      assertArrayEquals(before.lacing, after.lacing)
      assertEquals(before.granule, after.granule)
      assertEquals(before.headerType, after.headerType)
    }
  }

  @Test
  fun aLargeCoverSpansPagesAndShiftsTheAudio() {
    val (source, audio) = stream()
    val png = Random(3).nextBytes(200_000)
    val output = rewrite(source, listOf("CANTOR" to "v1;n;s;d"), flacPicture(png, 1000, 1000))
    assertChecksums(output)
    val pages = readAll(output)
    val tagPages = pages.size - 1 - audio.size
    assertTrue("a 200 KB cover takes several pages", tagPages >= 4)
    assertEquals(0, pages[1].headerType)
    pages.subList(2, 1 + tagPages).forEach { assertEquals(0x01, it.headerType) }
    pages.subList(1, 1 + tagPages).forEach { assertEquals(0L, it.granule) }
    assertEquals((0 until pages.size).toList(), pages.map { it.sequence })
    val picture = tagsOf(pages).comments.single { it.startsWith("METADATA_BLOCK_PICTURE=") }
    val block = Base64.getDecoder().decode(picture.substringAfter('='))
    assertArrayEquals(png, block.copyOfRange(block.size - png.size, block.size))
    // The scan's 64 KiB head still finds the marker.
    assertEquals("v1;n;s;d", cantorMarker(output.copyOf(64 * 1024)))
  }

  @Test
  fun aPacketOfExactlyWholeSegmentsEndsWithAnEmptyOne() {
    val (source, _) = stream(tags = emptyList())
    // Grow the comment until the packet is a multiple of 255 bytes.
    val base = "OpusTags".length + 4 + "libopus 1.4".length + 4 + 4 + "CANTOR=".length
    val value = "x".repeat(255 * 3 - base)
    val output = rewrite(source, listOf("CANTOR" to value))
    assertChecksums(output)
    val tags = readAll(output)[1]
    assertEquals(0, tags.lacing.last().toInt())
    assertEquals(value, tagsOf(readAll(output)).comments.first().substringAfter('='))
  }

  @Test
  fun refusesWhatIsNotOggOpus() {
    assertThrows(IllegalArgumentException::class.java) {
      rewrite("RIFF0000WAVEfmt ".toByteArray() + ByteArray(64), emptyList())
    }
    val vorbis = ByteArrayOutputStream().also { page(it, 0x02, 0, 0, listOf("\u0001vorbis".toByteArray())) }
    assertThrows(IllegalArgumentException::class.java) { rewrite(vorbis.toByteArray(), emptyList()) }
  }

  @Test
  fun findsNoMarkerWhereThereIsNone() {
    val (source, _) = stream()
    assertNull(cantorMarker(source))
    assertNull(cantorMarker("ID3".toByteArray()))
    assertNull(cantorMarker(ByteArray(0)))
    // A head cut inside the comment packet, before any marker, is not one.
    val output = rewrite(source, listOf("TITLE" to "t".repeat(70_000), "CANTOR" to "late"))
    assertNull(cantorMarker(output.copyOf(64 * 1024)))
  }

  @Test
  fun base64MatchesTheStandard() {
    val random = Random(11)
    for (size in 0..40) {
      val bytes = random.nextBytes(size)
      assertEquals(Base64.getEncoder().encodeToString(bytes), base64(bytes))
    }
  }
}
