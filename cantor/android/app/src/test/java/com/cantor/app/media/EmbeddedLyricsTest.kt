package com.cantor.app.media

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class EmbeddedLyricsTest {
  private lateinit var root: File

  @Before
  fun setUp() {
    root = Files.createTempDirectory("cantor-lyrics").toFile()
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  private fun file(name: String, bytes: ByteArray) = File(root, name).also { it.writeBytes(bytes) }

  private fun bytes(build: ByteArrayOutputStream.() -> Unit) = ByteArrayOutputStream().apply(build).toByteArray()

  private fun ByteArrayOutputStream.ascii(text: String) = write(text.toByteArray(Charsets.ISO_8859_1))

  private fun ByteArrayOutputStream.be32(value: Int) =
      write(byteArrayOf((value ushr 24).toByte(), (value ushr 16).toByte(), (value ushr 8).toByte(), value.toByte()))

  private fun ByteArrayOutputStream.le32(value: Int) =
      write(byteArrayOf(value.toByte(), (value ushr 8).toByte(), (value ushr 16).toByte(), (value ushr 24).toByte()))

  private fun ByteArrayOutputStream.syncsafe(value: Int) =
      write(byteArrayOf((value ushr 21 and 0x7f).toByte(), (value ushr 14 and 0x7f).toByte(),
          (value ushr 7 and 0x7f).toByte(), (value and 0x7f).toByte()))

  private fun flac(vararg comments: String): ByteArray {
    val streamInfo = ByteArray(34)
    val vorbis = bytes {
      val vendor = "test".toByteArray()
      le32(vendor.size); write(vendor)
      le32(comments.size)
      for (comment in comments) {
        val utf8 = comment.toByteArray(Charsets.UTF_8)
        le32(utf8.size); write(utf8)
      }
    }
    return bytes {
      ascii("fLaC")
      be32(34); write(streamInfo) // type 0, STREAMINFO
      be32((0x84 shl 24) or vorbis.size); write(vorbis) // last, type 4
      write(ByteArray(64))
    }
  }

  @Test
  fun readsFlacLyricsWhateverTheKeyCase() {
    val words = "[00:12.00] I run\nñandú and the night"
    val path = file("a.flac", flac("TITLE=I Run", "lyrics=$words"))
    assertEquals(words, embeddedLyrics(path))
  }

  @Test
  fun readsFlacUnsyncedLyrics() {
    val path = file("b.flac", flac("UNSYNCEDLYRICS=hold on"))
    assertEquals("hold on", embeddedLyrics(path))
  }

  @Test
  fun flacWithoutLyricsIsNull() {
    assertNull(embeddedLyrics(file("c.flac", flac("TITLE=Nightlight", "ARTIST=ILLENIUM"))))
  }

  private fun id3(version: Int, frame: ByteArray): ByteArray {
    val frames = bytes {
      ascii("TIT2")
      if (version == 4) syncsafe(5) else be32(5)
      write(byteArrayOf(0, 0)); write(byteArrayOf(3)); ascii("Tune")
      ascii("USLT")
      if (version == 4) syncsafe(frame.size) else be32(frame.size)
      write(byteArrayOf(0, 0)); write(frame)
    }
    return bytes {
      ascii("ID3"); write(byteArrayOf(version.toByte(), 0, 0))
      syncsafe(frames.size + 16); write(frames); write(ByteArray(16)) // padding
      write(byteArrayOf(0xff.toByte(), 0xfb.toByte()))
    }
  }

  @Test
  fun readsId3v24Utf8Lyrics() {
    val frame = bytes { write(3); ascii("eng"); write(0); write("ser libre".toByteArray(Charsets.UTF_8)) }
    assertEquals("ser libre", embeddedLyrics(file("d.mp3", id3(4, frame))))
  }

  @Test
  fun readsId3v23Utf16LyricsWithADescription() {
    val frame = bytes {
      write(1); ascii("eng")
      write("desc".toByteArray(Charsets.UTF_16LE).let { byteArrayOf(0xff.toByte(), 0xfe.toByte()) + it })
      write(byteArrayOf(0, 0))
      write(byteArrayOf(0xff.toByte(), 0xfe.toByte())); write("canción\n".toByteArray(Charsets.UTF_16LE))
    }
    assertEquals("canción\n", embeddedLyrics(file("e.mp3", id3(3, frame))))
  }

  @Test
  fun readsUtf16TextWithoutItsOwnBomInTheDescriptionsOrder() {
    val frame = bytes {
      write(1); ascii("eng")
      write(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0, 0)) // an empty description
      write("runaway".toByteArray(Charsets.UTF_16LE))
    }
    assertEquals("runaway", embeddedLyrics(file("f.mp3", id3(3, frame))))
  }

  private fun box(name: String, body: ByteArray) = bytes {
    be32(8 + body.size); write(name.toByteArray(Charsets.ISO_8859_1)); write(body)
  }

  @Test
  fun readsMp4Lyrics() {
    val data = box("data", bytes { be32(1); be32(0); write("it's only".toByteArray()) })
    val ilst = box("ilst", box("©nam", box("data", ByteArray(12))) + box("©lyr", data))
    val meta = box("meta", ByteArray(4) + box("hdlr", ByteArray(25)) + ilst)
    val mp4 = box("ftyp", "M4A \u0000\u0000\u0000\u0000".toByteArray(Charsets.ISO_8859_1)) +
        box("moov", box("mvhd", ByteArray(100)) + box("udta", meta)) + box("mdat", ByteArray(32))
    assertEquals("it's only", embeddedLyrics(file("g.m4a", mp4)))
  }

  @Test
  fun anythingElseOrABrokenTagIsNull() {
    assertNull(embeddedLyrics(file("h.wav", "RIFF\u0000\u0000\u0000\u0000WAVE".toByteArray())))
    assertNull(embeddedLyrics(file("i.flac", flac("LYRICS=x").copyOfRange(0, 50))))
    assertNull(embeddedLyrics(file("j.flac", "fLaC".toByteArray() + byteArrayOf(0x84.toByte(), 0x7f, 0x7f, 0x7f))))
    assertNull(embeddedLyrics(File(root, "missing.mp3")))
  }
}
