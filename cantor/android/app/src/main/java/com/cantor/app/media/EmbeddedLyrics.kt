package com.cantor.app.media

import java.io.File
import java.io.RandomAccessFile
import java.nio.charset.Charset

/** The most bytes of a tag block read; past this a tag is a picture, not words. */
private const val MAX_TAG_BYTES = 16 * 1024 * 1024

/** Vorbis comment keys that hold a song's words, as players write them. */
private val VORBIS_LYRICS_KEYS = setOf("LYRICS", "UNSYNCEDLYRICS", "UNSYNCED LYRICS")

/**
 * The words a file carries in its own tags, raw (an LRC file's timestamps
 * included), or null. `MediaMetadataRetriever` reads no lyrics, so this reads
 * the three containers a music library holds them in: FLAC's Vorbis comment,
 * MP3's ID3v2 `USLT`, and MP4's `©lyr`. Anything else, or a tag it cannot
 * parse, is null: missing words are a fallback, never an error.
 */
fun embeddedLyrics(file: File): String? =
    try {
      RandomAccessFile(file, "r").use { input ->
        val magic = ByteArray(8)
        if (input.read(magic) < 8) return null
        when {
          magic.startsWith("fLaC") -> flacLyrics(input)
          magic.startsWith("ID3") -> id3Lyrics(input)
          magic.copyOfRange(4, 8).startsWith("ftyp") -> mp4Lyrics(input)
          else -> null
        }
      }?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
      null
    }

private fun ByteArray.startsWith(ascii: String): Boolean =
    size >= ascii.length && ascii.indices.all { this[it] == ascii[it].code.toByte() }

private fun RandomAccessFile.block(at: Long, length: Long): ByteArray? {
  if (length < 0 || length > MAX_TAG_BYTES || at + length > length()) return null
  seek(at)
  return ByteArray(length.toInt()).also { readFully(it) }
}

private fun ByteArray.u32be(at: Int): Long =
    ((this[at].toLong() and 0xff) shl 24) or ((this[at + 1].toLong() and 0xff) shl 16) or
        ((this[at + 2].toLong() and 0xff) shl 8) or (this[at + 3].toLong() and 0xff)

private fun ByteArray.u32le(at: Int): Long =
    (this[at].toLong() and 0xff) or ((this[at + 1].toLong() and 0xff) shl 8) or
        ((this[at + 2].toLong() and 0xff) shl 16) or ((this[at + 3].toLong() and 0xff) shl 24)

// FLAC: metadata blocks after the magic; the Vorbis comment is type 4, its
// lengths little-endian, each comment `KEY=value`.
private fun flacLyrics(input: RandomAccessFile): String? {
  var at = 4L
  while (at + 4 <= input.length()) {
    val header = input.block(at, 4) ?: return null
    val last = header[0].toInt() and 0x80 != 0
    val type = header[0].toInt() and 0x7f
    val length = header.u32be(0) and 0xffffff
    if (type == 4) {
      val body = input.block(at + 4, length) ?: return null
      return vorbisLyrics(body)
    }
    if (last) return null
    at += 4 + length
  }
  return null
}

private fun vorbisLyrics(body: ByteArray): String? {
  var at = 0
  fun next(): Int? {
    if (at + 4 > body.size) return null
    val value = body.u32le(at)
    at += 4
    return if (value > body.size - at) null else value.toInt()
  }
  val vendor = next() ?: return null
  at += vendor
  val count = next() ?: return null
  repeat(count) {
    val length = next() ?: return null
    val comment = String(body, at, length, Charsets.UTF_8)
    at += length
    val equals = comment.indexOf('=')
    if (equals > 0 && comment.substring(0, equals).uppercase() in VORBIS_LYRICS_KEYS) {
      return comment.substring(equals + 1)
    }
  }
  return null
}

// ID3v2.3 and 2.4: a syncsafe tag size, then frames. 2.4 frame sizes are
// syncsafe, 2.3's are plain; an unsynchronised 2.3 tag is undone whole first.
private fun id3Lyrics(input: RandomAccessFile): String? {
  val header = input.block(0, 10) ?: return null
  val version = header[3].toInt()
  if (version != 3 && version != 4) return null
  val flags = header[5].toInt()
  var tag = input.block(10, syncsafe(header, 6)) ?: return null
  if (version == 3 && flags and 0x80 != 0) tag = resynchronise(tag)
  var at = 0
  if (flags and 0x40 != 0) {
    // The extended header: 2.4's size counts itself, 2.3's does not.
    at = if (version == 4) syncsafe(tag, 0).toInt() else tag.u32be(0).toInt() + 4
  }
  while (at + 10 <= tag.size && tag[at] != 0.toByte()) {
    val id = String(tag, at, 4, Charsets.ISO_8859_1)
    val size = (if (version == 4) syncsafe(tag, at + 4) else tag.u32be(at + 4)).toInt()
    val start = at + 10
    if (size < 0 || start + size > tag.size) return null
    if (id == "USLT" && size > 4) return usltText(tag.copyOfRange(start, start + size))
    at = start + size
  }
  return null
}

private fun syncsafe(bytes: ByteArray, at: Int): Long =
    (0 until 4).fold(0L) { value, i -> (value shl 7) or (bytes[at + i].toLong() and 0x7f) }

private fun resynchronise(bytes: ByteArray): ByteArray {
  val out = java.io.ByteArrayOutputStream(bytes.size)
  var i = 0
  while (i < bytes.size) {
    out.write(bytes[i].toInt())
    if (bytes[i] == 0xff.toByte() && i + 1 < bytes.size && bytes[i + 1] == 0.toByte()) i++
    i++
  }
  return out.toByteArray()
}

// USLT: encoding, a three-letter language, a terminated description, the text.
private fun usltText(frame: ByteArray): String? {
  val charset: Charset
  val wide: Boolean
  when (frame[0].toInt()) {
    0 -> { charset = Charsets.ISO_8859_1; wide = false }
    1 -> { charset = Charsets.UTF_16; wide = true }
    2 -> { charset = Charsets.UTF_16BE; wide = true }
    3 -> { charset = Charsets.UTF_8; wide = false }
    else -> return null
  }
  var at = 4
  while (true) {
    if (at + (if (wide) 1 else 0) >= frame.size) return null
    if (!wide && frame[at] == 0.toByte()) { at += 1; break }
    if (wide && frame[at] == 0.toByte() && frame[at + 1] == 0.toByte()) { at += 2; break }
    at += if (wide) 2 else 1
  }
  // Each UTF-16 string carries its own BOM; a writer that leaves it off the
  // text means the description's byte order, not Java's big-endian default.
  val textCharset =
      if (frame[0].toInt() == 1 && !hasBom(frame, at) && hasBom(frame, 4) &&
          frame[4] == 0xff.toByte()) {
        Charsets.UTF_16LE
      } else {
        charset
      }
  return String(frame, at, frame.size - at, textCharset).trimEnd('\u0000')
}

private fun hasBom(bytes: ByteArray, at: Int): Boolean =
    at + 1 < bytes.size &&
        ((bytes[at] == 0xff.toByte() && bytes[at + 1] == 0xfe.toByte()) ||
            (bytes[at] == 0xfe.toByte() && bytes[at + 1] == 0xff.toByte()))

// MP4: moov > udta > meta (a full box: four bytes of version and flags) >
// ilst > ©lyr > data (eight bytes of type and locale, then UTF-8).
private fun mp4Lyrics(input: RandomAccessFile): String? {
  val moov = mp4Child(input, 0, input.length(), "moov") ?: return null
  val udta = mp4Child(input, moov.first, moov.second, "udta") ?: return null
  val meta = mp4Child(input, udta.first, udta.second, "meta") ?: return null
  val ilst = mp4Child(input, meta.first + 4, meta.second, "ilst") ?: return null
  val lyr = mp4Child(input, ilst.first, ilst.second, "©lyr") ?: return null
  val data = mp4Child(input, lyr.first, lyr.second, "data") ?: return null
  val body = input.block(data.first + 8, data.second - data.first - 8) ?: return null
  return String(body, Charsets.UTF_8)
}

/** The child box `name` in `[from, to)`: where its body starts and ends. */
private fun mp4Child(input: RandomAccessFile, from: Long, to: Long, name: String): Pair<Long, Long>? {
  var at = from
  while (at + 8 <= to) {
    val header = input.block(at, minOf(16L, to - at)) ?: return null
    var size = header.u32be(0)
    var bodyAt = at + 8
    if (size == 1L && header.size >= 16) {
      size = (header.u32be(8) shl 32) or header.u32be(12)
      bodyAt = at + 16
    } else if (size == 0L) {
      size = to - at
    }
    if (size < bodyAt - at || at + size > to) return null
    if (String(header, 4, 4, Charsets.ISO_8859_1) == name) return bodyAt to at + size
    at += size
  }
  return null
}
