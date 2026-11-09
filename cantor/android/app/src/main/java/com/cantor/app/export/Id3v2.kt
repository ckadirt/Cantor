package com.cantor.app.export

import java.io.ByteArrayOutputStream

/**
 * The ID3v2.4 tag an exported MP3 starts with
 * (internal/docs/plans/take-it-plan.md, "Formats on disk").
 *
 * The same pairs the Opus file carries (`KEY` to value, the marker first),
 * each as the frame players read for it: `TIT2`, `TALB`, `TPE1`, `USLT`,
 * `COMM`, and `TXXX` for anything else, Cantor's marker included. The cover
 * is the last frame, so the marker stays inside the 64 KiB a scan reads.
 * Text is UTF-8, which version 2.4 allows and Android's readers understand.
 */
private const val UTF8: Int = 3

/** Frames for the keys players know; any other key is a `TXXX` named after it. */
private val TEXT_FRAMES = mapOf("TITLE" to "TIT2", "ALBUM" to "TALB", "ARTIST" to "TPE1")

/** "Language unknown", as ID3 spells it for lyrics and comments. */
private const val NO_LANGUAGE = "XXX"

internal fun id3v2Tag(
    tags: List<Pair<String, String>>,
    cover: ByteArray? = null,
    coverMime: String = "image/png",
): ByteArray {
  val frames = ByteArrayOutputStream()
  for ((key, value) in tags) {
    val upper = key.uppercase()
    val textFrame = TEXT_FRAMES[upper]
    when {
      textFrame != null -> frames.write(frame(textFrame, byteArrayOf(UTF8.toByte()) + value.utf8()))
      upper == "LYRICS" -> frames.write(frame("USLT", languageText(value)))
      upper == "DESCRIPTION" -> frames.write(frame("COMM", languageText(value)))
      else -> frames.write(
          frame("TXXX", byteArrayOf(UTF8.toByte()) + key.utf8() + 0 + value.utf8()),
      )
    }
  }
  if (cover != null) {
    val body = ByteArrayOutputStream()
    body.write(UTF8)
    body.write(coverMime.toByteArray(Charsets.ISO_8859_1))
    body.write(0)
    body.write(3) // front cover
    body.write(0) // no description
    body.write(cover)
    frames.write(frame("APIC", body.toByteArray()))
  }
  val content = frames.toByteArray()
  val header = byteArrayOf(
      'I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(),
      4, 0, // version 2.4.0
      0, // no flags
  ) + syncsafe(content.size)
  return header + content
}

/**
 * The value of the first `TXXX` frame described as `description` that lies
 * wholly inside `head`, a file's first bytes; null for anything else. Reads
 * versions 2.3 and 2.4, which differ in how a frame's size is written.
 */
internal fun id3TxxxInHead(head: ByteArray, description: String): String? {
  if (head.size < 10 || head[0] != 'I'.code.toByte() || head[1] != 'D'.code.toByte() ||
      head[2] != '3'.code.toByte()) return null
  val version = head[3].toInt()
  if (version != 3 && version != 4) return null
  val flags = head[5].toInt() and 0xff
  // An unsynchronised tag would need undoing first; Cantor never writes one.
  if (flags and 0x80 != 0) return null
  val end = minOf(head.size, 10 + readSyncsafe(head, 6))
  var at = 10
  if (flags and 0x40 != 0) {
    // The extended header's size is syncsafe and inclusive in 2.4, plain and exclusive in 2.3.
    if (at + 4 > end) return null
    at += if (version == 4) readSyncsafe(head, at) else readPlain(head, at) + 4
  }
  while (at + 10 <= end) {
    if (head[at].toInt() == 0) return null // padding
    val id = String(head, at, 4, Charsets.ISO_8859_1)
    val size = if (version == 4) readSyncsafe(head, at + 4) else readPlain(head, at + 4)
    val body = at + 10
    if (size < 0 || body + size > end) return null
    if (id == "TXXX" && size > 1) {
      val encoding = head[body].toInt()
      if (encoding == 0 || encoding == UTF8) {
        val text = String(
            head, body + 1, size - 1, if (encoding == 0) Charsets.ISO_8859_1 else Charsets.UTF_8,
        )
        val split = text.indexOf('\u0000')
        if (split >= 0 && text.substring(0, split) == description) {
          return text.substring(split + 1).trimEnd('\u0000')
        }
      }
    }
    at = body + size
  }
  return null
}

private fun languageText(value: String): ByteArray =
    byteArrayOf(UTF8.toByte()) + NO_LANGUAGE.toByteArray(Charsets.ISO_8859_1) + 0 + value.utf8()

private fun frame(id: String, body: ByteArray): ByteArray =
    id.toByteArray(Charsets.ISO_8859_1) + syncsafe(body.size) + byteArrayOf(0, 0) + body

private fun String.utf8(): ByteArray = toByteArray(Charsets.UTF_8)

private operator fun ByteArray.plus(byte: Int): ByteArray = this + byteArrayOf(byte.toByte())

/** A 28-bit size in four 7-bit bytes, so no tag byte ever looks like an MPEG sync. */
private fun syncsafe(value: Int): ByteArray {
  require(value in 0..0x0FFFFFFF) { "An ID3 tag is limited to 256 MB." }
  return byteArrayOf(
      (value ushr 21 and 0x7f).toByte(),
      (value ushr 14 and 0x7f).toByte(),
      (value ushr 7 and 0x7f).toByte(),
      (value and 0x7f).toByte(),
  )
}

private fun readSyncsafe(bytes: ByteArray, at: Int): Int =
    ((bytes[at].toInt() and 0x7f) shl 21) or ((bytes[at + 1].toInt() and 0x7f) shl 14) or
        ((bytes[at + 2].toInt() and 0x7f) shl 7) or (bytes[at + 3].toInt() and 0x7f)

private fun readPlain(bytes: ByteArray, at: Int): Int =
    ((bytes[at].toInt() and 0xff) shl 24) or ((bytes[at + 1].toInt() and 0xff) shl 16) or
        ((bytes[at + 2].toInt() and 0xff) shl 8) or (bytes[at + 3].toInt() and 0xff)
