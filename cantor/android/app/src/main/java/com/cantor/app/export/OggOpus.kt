package com.cantor.app.export

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream
import java.io.OutputStream

/**
 * An Ogg Opus file with its tags replaced, and nothing else touched
 * (internal/docs/plans/take-it-plan.md, "The Opus tag rewrite").
 *
 * The app's FFmpeg has no Ogg muxer, and the job is small: RFC 7845 puts the
 * comment header (`OpusTags`) in a packet of its own that starts and ends on
 * pages of its own, between the identification header and the first audio
 * page. So the identification page is copied, the comment pages are rebuilt,
 * and every audio page is copied byte for byte except its sequence number and
 * its checksum, which move by however many pages the new comments took.
 * Granule positions, and so timing and gapless trims, are untouched.
 */

private const val OGG_HEADER_BYTES = 27
private const val CONTINUED: Int = 0x01
private const val BEGINNING: Int = 0x02
private const val MAX_SEGMENTS = 255
private const val MAX_HEADER_PACKET_BYTES = 32 * 1024 * 1024

/** One Ogg page, header fields decoded, body as it was. */
internal class OggPage(
    val headerType: Int,
    val granule: Long,
    val serial: Int,
    val sequence: Int,
    val lacing: ByteArray,
    val body: ByteArray,
) {
  /** The page's segments end a packet (its last lacing value is under 255). */
  val endsPacket: Boolean
    get() = lacing.isNotEmpty() && (lacing.last().toInt() and 0xff) < 255

  fun write(output: OutputStream, sequence: Int = this.sequence) =
      writePage(output, headerType, granule, serial, sequence, lacing, body)
}

/** The next page, or null at a clean end of stream. */
internal fun readPage(input: InputStream): OggPage? {
  val header = ByteArray(OGG_HEADER_BYTES)
  val first = input.read(header, 0, OGG_HEADER_BYTES)
  if (first <= 0) return null
  readFully(input, header, first, OGG_HEADER_BYTES - first)
  require(
      header[0] == 'O'.code.toByte() && header[1] == 'g'.code.toByte() &&
          header[2] == 'g'.code.toByte() && header[3] == 'S'.code.toByte(),
  ) { "Not an Ogg page." }
  require(header[4].toInt() == 0) { "Unknown Ogg version." }
  val segments = header[26].toInt() and 0xff
  val lacing = ByteArray(segments).also { readFully(input, it, 0, segments) }
  val bodyBytes = lacing.sumOf { it.toInt() and 0xff }
  val body = ByteArray(bodyBytes).also { readFully(input, it, 0, bodyBytes) }
  return OggPage(
      headerType = header[5].toInt() and 0xff,
      granule = le64(header, 6),
      serial = le32(header, 14),
      sequence = le32(header, 18),
      lacing = lacing,
      body = body,
  )
}

/**
 * Copy `source` to `target` with its comment header replaced by `comments`
 * (each `KEY=value`, in order), its vendor string kept, and a picture added
 * when given. Existing comments whose key is not among the new ones are kept
 * after them, so an encoder's own notes survive.
 */
internal fun rewriteOpusTags(
    source: File,
    target: File,
    comments: List<Pair<String, String>>,
    picture: ByteArray? = null,
) {
  BufferedInputStream(source.inputStream()).use { input ->
    BufferedOutputStream(target.outputStream()).use { output ->
      rewriteOpusTags(input, output, comments, picture)
    }
  }
}

internal fun rewriteOpusTags(
    input: InputStream,
    output: OutputStream,
    comments: List<Pair<String, String>>,
    picture: ByteArray? = null,
) {
  val head = readPage(input) ?: error("The file is empty.")
  require(head.headerType and BEGINNING != 0 && head.body.startsWithAscii("OpusHead")) {
    "Not an Ogg Opus file."
  }
  require(head.endsPacket && head.lacing.count { (it.toInt() and 0xff) < 255 } == 1) {
    "The identification header does not stand alone."
  }

  // The comment packet, whole: it must end on a page boundary (RFC 7845 §3).
  val old = ByteArrayOutputStream()
  var tagPages = 0
  while (true) {
    val page = readPage(input) ?: error("The file ends inside its comment header.")
    require(page.serial == head.serial) { "A second logical stream is not supported." }
    val ends = page.lacing.indexOfFirst { (it.toInt() and 0xff) < 255 }
    require(ends == -1 || ends == page.lacing.lastIndex) {
      "The comment header shares a page with audio."
    }
    old.write(page.body)
    require(old.size() <= MAX_HEADER_PACKET_BYTES) { "The comment header is too large." }
    tagPages += 1
    if (page.endsPacket) break
  }
  val parsed = parseOpusTags(old.toByteArray())

  val keys = comments.map { it.first.uppercase() }.toSet() + "METADATA_BLOCK_PICTURE"
  val merged = buildList {
    comments.forEach { (key, value) -> add("$key=$value") }
    picture?.let { add("METADATA_BLOCK_PICTURE=" + base64(it)) }
    parsed.comments
        .filter { comment -> comment.substringBefore('=').uppercase() !in keys }
        .forEach(::add)
  }

  head.write(output)
  val written = writePacketPages(
      output, opusTags(parsed.vendor, merged), head.serial, firstSequence = head.sequence + 1,
  )
  val shift = written - tagPages
  while (true) {
    val page = readPage(input) ?: break
    page.write(output, page.sequence + shift)
  }
}

/** A comment header's vendor string and its comments, raw (`KEY=value`). */
internal class OpusTags(val vendor: String, val comments: List<String>)

internal fun parseOpusTags(packet: ByteArray): OpusTags {
  require(packet.startsWithAscii("OpusTags")) { "Not an Opus comment header." }
  var at = 8
  fun next(): Int {
    require(at + 4 <= packet.size) { "The comment header is cut short." }
    val value = le32(packet, at).toLong() and 0xffffffffL
    at += 4
    require(value <= packet.size - at) { "The comment header is cut short." }
    return value.toInt()
  }
  val vendorBytes = next()
  val vendor = String(packet, at, vendorBytes, Charsets.UTF_8)
  at += vendorBytes
  val count = next()
  val comments = ArrayList<String>()
  repeat(count) {
    val length = next()
    comments += String(packet, at, length, Charsets.UTF_8)
    at += length
  }
  return OpusTags(vendor, comments)
}

/**
 * The value of the first comment called `key` that lies wholly inside `head`,
 * a file's first bytes, or null. For the device scan, which reads 64 KiB and
 * must not open the file again: the marker is written first for this.
 */
internal fun opusCommentInHead(head: ByteArray, key: String): String? {
  // Walked by offset rather than read as whole pages: a large cover makes the
  // first comment page longer than the head, and the marker is at its start.
  var at = 0
  var index = 0
  val packet = ByteArrayOutputStream()
  while (at + OGG_HEADER_BYTES <= head.size) {
    if (!head.copyOfRange(at, at + 4).startsWithAscii("OggS")) return null
    val segments = head[at + 26].toInt() and 0xff
    if (at + OGG_HEADER_BYTES + segments > head.size) break
    val lacing = head.copyOfRange(at + OGG_HEADER_BYTES, at + OGG_HEADER_BYTES + segments)
    val bodyStart = at + OGG_HEADER_BYTES + segments
    val bodyBytes = lacing.sumOf { it.toInt() and 0xff }
    val available = minOf(bodyBytes, head.size - bodyStart)
    if (index == 0) {
      if (!head.copyOfRange(bodyStart, bodyStart + available).startsWithAscii("OpusHead")) {
        return null
      }
    } else {
      packet.write(head, bodyStart, available)
      val ends = lacing.isNotEmpty() && (lacing.last().toInt() and 0xff) < 255
      if (available < bodyBytes || ends) break
    }
    at = bodyStart + bodyBytes
    index += 1
  }
  return firstComment(packet.toByteArray(), key)
}

/** Read comments from a possibly cut-short packet, as far as it goes. */
private fun firstComment(packet: ByteArray, key: String): String? {
  if (!packet.startsWithAscii("OpusTags")) return null
  var at = 8
  fun next(): Long? {
    if (at + 4 > packet.size) return null
    return (le32(packet, at).toLong() and 0xffffffffL).also { at += 4 }
  }
  val vendor = next() ?: return null
  at += vendor.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
  val count = next() ?: return null
  val wanted = key.uppercase() + "="
  for (index in 0 until count) {
    val length = next() ?: return null
    if (length > packet.size - at) return null
    val comment = String(packet, at, length.toInt(), Charsets.UTF_8)
    at += length.toInt()
    if (comment.uppercase().startsWith(wanted)) return comment.substring(wanted.length)
  }
  return null
}

/**
 * A FLAC picture block (front cover), the body of `METADATA_BLOCK_PICTURE`.
 */
internal fun flacPicture(png: ByteArray, width: Int, height: Int): ByteArray {
  val out = ByteArrayOutputStream()
  fun u32(value: Int) {
    out.write(value ushr 24 and 0xff); out.write(value ushr 16 and 0xff)
    out.write(value ushr 8 and 0xff); out.write(value and 0xff)
  }
  val mime = "image/png".toByteArray(Charsets.US_ASCII)
  u32(3) // front cover
  u32(mime.size); out.write(mime)
  u32(0) // no description
  u32(width); u32(height)
  u32(24) // colour depth
  u32(0) // not indexed
  u32(png.size); out.write(png)
  return out.toByteArray()
}

private fun opusTags(vendor: String, comments: List<String>): ByteArray {
  val out = ByteArrayOutputStream()
  fun u32(value: Int) {
    out.write(value and 0xff); out.write(value ushr 8 and 0xff)
    out.write(value ushr 16 and 0xff); out.write(value ushr 24 and 0xff)
  }
  out.write("OpusTags".toByteArray(Charsets.US_ASCII))
  val vendorBytes = vendor.toByteArray(Charsets.UTF_8)
  u32(vendorBytes.size); out.write(vendorBytes)
  u32(comments.size)
  for (comment in comments) {
    val bytes = comment.toByteArray(Charsets.UTF_8)
    u32(bytes.size); out.write(bytes)
  }
  return out.toByteArray()
}

/** Lay one header packet on as many pages as it needs; returns how many. */
private fun writePacketPages(
    output: OutputStream,
    packet: ByteArray,
    serial: Int,
    firstSequence: Int,
): Int {
  // 255-byte segments, then the remainder (0 when the packet is a multiple).
  val lacing = ArrayList<Int>()
  var left = packet.size
  while (left >= 255) {
    lacing += 255
    left -= 255
  }
  lacing += left
  var pages = 0
  var segment = 0
  var offset = 0
  while (segment < lacing.size) {
    val count = minOf(MAX_SEGMENTS, lacing.size - segment)
    val values = lacing.subList(segment, segment + count)
    val bytes = values.sum()
    writePage(
        output,
        headerType = if (pages == 0) 0 else CONTINUED,
        granule = 0,
        serial = serial,
        sequence = firstSequence + pages,
        lacing = ByteArray(count) { values[it].toByte() },
        body = packet.copyOfRange(offset, offset + bytes),
    )
    offset += bytes
    segment += count
    pages += 1
  }
  return pages
}

private fun writePage(
    output: OutputStream,
    headerType: Int,
    granule: Long,
    serial: Int,
    sequence: Int,
    lacing: ByteArray,
    body: ByteArray,
) {
  val header = ByteArray(OGG_HEADER_BYTES + lacing.size)
  "OggS".forEachIndexed { index, c -> header[index] = c.code.toByte() }
  header[4] = 0
  header[5] = headerType.toByte()
  for (i in 0 until 8) header[6 + i] = (granule ushr (8 * i)).toByte()
  putLe32(header, 14, serial)
  putLe32(header, 18, sequence)
  header[26] = lacing.size.toByte()
  lacing.copyInto(header, OGG_HEADER_BYTES)
  val crc = oggCrc(oggCrc(0, header), body)
  putLe32(header, 22, crc)
  output.write(header)
  output.write(body)
}

private val CRC_TABLE = IntArray(256) { index ->
  var r = index shl 24
  repeat(8) { r = if (r and 0x80000000.toInt() != 0) (r shl 1) xor 0x04c11db7 else r shl 1 }
  r
}

/** Ogg's CRC-32: polynomial 0x04c11db7, unreflected, from 0, no final xor. */
internal fun oggCrc(start: Int, bytes: ByteArray): Int {
  var crc = start
  for (byte in bytes) {
    crc = (crc shl 8) xor CRC_TABLE[((crc ushr 24) xor (byte.toInt() and 0xff)) and 0xff]
  }
  return crc
}

private const val BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Standard base64 with padding, no line breaks (java.util.Base64 needs API 26). */
internal fun base64(bytes: ByteArray): String {
  val out = StringBuilder((bytes.size + 2) / 3 * 4)
  var i = 0
  while (i < bytes.size) {
    val b0 = bytes[i].toInt() and 0xff
    val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xff else 0
    val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xff else 0
    out.append(BASE64[b0 ushr 2])
    out.append(BASE64[(b0 and 0x03) shl 4 or (b1 ushr 4)])
    out.append(if (i + 1 < bytes.size) BASE64[(b1 and 0x0f) shl 2 or (b2 ushr 6)] else '=')
    out.append(if (i + 2 < bytes.size) BASE64[b2 and 0x3f] else '=')
    i += 3
  }
  return out.toString()
}

private fun readFully(input: InputStream, into: ByteArray, from: Int, length: Int) {
  var done = 0
  while (done < length) {
    val read = input.read(into, from + done, length - done)
    if (read < 0) throw EOFException("The Ogg stream is cut short.")
    done += read
  }
}

private fun ByteArray.startsWithAscii(ascii: String): Boolean =
    size >= ascii.length && ascii.indices.all { this[it] == ascii[it].code.toByte() }

private fun le32(bytes: ByteArray, at: Int): Int =
    (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8) or
        ((bytes[at + 2].toInt() and 0xff) shl 16) or ((bytes[at + 3].toInt() and 0xff) shl 24)

private fun le64(bytes: ByteArray, at: Int): Long {
  var value = 0L
  for (i in 7 downTo 0) value = (value shl 8) or (bytes[at + i].toLong() and 0xff)
  return value
}

private fun putLe32(bytes: ByteArray, at: Int, value: Int) {
  for (i in 0 until 4) bytes[at + i] = (value ushr (8 * i)).toByte()
}
