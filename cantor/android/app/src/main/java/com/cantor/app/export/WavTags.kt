package com.cantor.app.export

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream

/**
 * The node's master with Cantor's tags in it (internal/docs/plans/take-it-plan.md,
 * "Formats on disk"): a `cntr` chunk holding the marker, then a `LIST/INFO`
 * chunk with what players read, both between `fmt ` and the rest. Every other
 * chunk, the audio included, is copied byte for byte; only the RIFF size moves.
 *
 * The marker sits right after `fmt `, a few dozen bytes in, so the device scan
 * finds it in the 64 KiB it reads.
 */
private const val MARKER_CHUNK = "cntr"

/** INFO ids for the pairs Cantor writes; anything else has no INFO field. */
private val INFO_IDS = mapOf("TITLE" to "INAM", "ARTIST" to "IART", "ALBUM" to "IPRD", "DESCRIPTION" to "ICMT")

internal fun tagWav(input: InputStream, output: OutputStream, tags: List<Pair<String, String>>) {
  val header = input.readExactly(12)
  require(header.ascii(0, 4) == "RIFF" && header.ascii(8, 4) == "WAVE") { "Not a WAV file." }
  val riffSize = header.le32(4)

  // `fmt ` first, as every WAV has it; the new chunks follow it.
  val fmtHeader = input.readExactly(8)
  require(fmtHeader.ascii(0, 4) == "fmt ") { "The WAV does not start with its format." }
  val fmtBody = input.readExactly(padded(fmtHeader.le32(4)))

  val added = ByteArrayOutputStream()
  tags.firstOrNull { it.first.equals(CANTOR_MARKER_KEY, ignoreCase = true) }?.let { (_, marker) ->
    added.write(chunk(MARKER_CHUNK, marker.toByteArray(Charsets.UTF_8)))
  }
  val info = ByteArrayOutputStream()
  info.write("INFO".toByteArray(Charsets.US_ASCII))
  for ((key, value) in tags) {
    val id = INFO_IDS[key.uppercase()] ?: continue
    // INFO strings are zero-terminated.
    info.write(chunk(id, value.toByteArray(Charsets.UTF_8) + 0))
  }
  if (info.size() > 4) added.write(chunk("LIST", info.toByteArray()))

  val extra = added.size().toLong()
  val newSize = riffSize + extra
  require(newSize <= 0xFFFFFFFFL) { "The WAV would be too large to tag." }
  output.write(header.copyOf(4))
  output.write(le32(newSize))
  output.write(header, 8, 4)
  output.write(fmtHeader)
  output.write(fmtBody)
  output.write(added.toByteArray())
  input.copyTo(output)
}

/** The marker in a WAV's first bytes: the `cntr` chunk's text, or null. */
internal fun wavMarkerInHead(head: ByteArray): String? {
  if (head.size < 12 || head.ascii(0, 4) != "RIFF" || head.ascii(8, 4) != "WAVE") return null
  var at = 12
  while (at + 8 <= head.size) {
    val id = head.ascii(at, 4)
    val size = head.le32(at + 4)
    val body = at + 8
    if (id == MARKER_CHUNK) {
      return if (body + size <= head.size) String(head, body, size.toInt(), Charsets.UTF_8) else null
    }
    // The audio is too large to step over inside a head, and no tag follows it.
    if (id == "data") return null
    at = body + padded(size)
  }
  return null
}

private fun chunk(id: String, body: ByteArray): ByteArray {
  val out = ByteArrayOutputStream()
  out.write(id.toByteArray(Charsets.US_ASCII))
  out.write(le32(body.size.toLong()))
  out.write(body)
  if (body.size % 2 == 1) out.write(0) // chunks are word-aligned
  return out.toByteArray()
}

private fun padded(size: Long): Int = (size + (size and 1)).toInt()

private fun le32(value: Long): ByteArray =
    ByteArray(4) { (value ushr (8 * it)).toByte() }

private fun ByteArray.le32(at: Int): Long =
    (this[at].toLong() and 0xff) or ((this[at + 1].toLong() and 0xff) shl 8) or
        ((this[at + 2].toLong() and 0xff) shl 16) or ((this[at + 3].toLong() and 0xff) shl 24)

private fun ByteArray.ascii(at: Int, length: Int): String = String(this, at, length, Charsets.US_ASCII)

private operator fun ByteArray.plus(byte: Int): ByteArray = this + byteArrayOf(byte.toByte())

private fun InputStream.readExactly(count: Int): ByteArray {
  val bytes = ByteArray(count)
  var done = 0
  while (done < count) {
    val read = read(bytes, done, count - done)
    if (read < 0) throw EOFException("The WAV is cut short.")
    done += read
  }
  return bytes
}
