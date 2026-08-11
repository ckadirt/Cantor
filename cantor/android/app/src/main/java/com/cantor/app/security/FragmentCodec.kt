package com.cantor.app.security

import com.cantor.app.transport.GeneratedTransport.FRAGMENT_RECORD_HEADER_BYTES
import com.cantor.app.transport.GeneratedTransport.FRAGMENT_RECORD_KIND
import com.cantor.app.transport.GeneratedTransport.MAX_FRAGMENT_DATA_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_LOGICAL_INNER_BYTES
import com.cantor.app.transport.GeneratedTransport.SECURE_RECORD_VERSION
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Exact secure fragment record framing.
 *
 * Nothing here knows about Noise. A record is the plaintext the cipher state
 * protects: one header plus one slice of a logical inner message.
 */
internal object FragmentCodec {
  /** How many fragments a logical inner message of [length] bytes occupies. */
  fun fragmentCount(length: Int): Int {
    require(length in 1..MAX_LOGICAL_INNER_BYTES) { "Secure inner message is outside its bound." }
    val count = (length + MAX_FRAGMENT_DATA_BYTES - 1) / MAX_FRAGMENT_DATA_BYTES
    require(count in 1..0xffff) { "Secure message has too many fragments." }
    return count
  }

  fun encodeRecord(
      messageId: Long,
      index: Int,
      count: Int,
      totalLength: Int,
      data: ByteArray,
      offset: Int,
      length: Int,
  ): ByteArray {
    val record = ByteArray(FRAGMENT_RECORD_HEADER_BYTES + length)
    ByteBuffer.wrap(record).order(ByteOrder.BIG_ENDIAN).apply {
      put(SECURE_RECORD_VERSION)
      put(FRAGMENT_RECORD_KIND)
      putInt(messageId.toInt())
      putShort(index.toShort())
      putShort(count.toShort())
      putInt(totalLength)
      putInt(length)
      put(data, offset, length)
    }
    return record
  }
}

/**
 * Accepts fragments for exactly one message at a time, in order, starting at the
 * message id that follows the last completed one.
 */
internal class FragmentReassembler {
  private var expectedMessageId = 0L
  private var assembly: Assembly? = null

  /** Returns the completed inner message, or null while fragments remain. */
  fun accept(plaintext: ByteArray, length: Int): ByteArray? {
    require(length >= FRAGMENT_RECORD_HEADER_BYTES) { "Secure fragment is truncated." }
    val buffer = ByteBuffer.wrap(plaintext, 0, length).order(ByteOrder.BIG_ENDIAN)
    require(buffer.get() == SECURE_RECORD_VERSION && buffer.get() == FRAGMENT_RECORD_KIND) {
      "Secure fragment header is invalid."
    }
    val messageId = buffer.int.toLong() and 0xffff_ffffL
    val fragmentIndex = buffer.short.toInt() and 0xffff
    val fragmentCount = buffer.short.toInt() and 0xffff
    val totalLength = buffer.int
    val fragmentLength = buffer.int
    require(
        messageId == expectedMessageId &&
            fragmentCount > 0 &&
            fragmentIndex < fragmentCount &&
            totalLength in 1..MAX_LOGICAL_INNER_BYTES &&
            fragmentLength in 1..MAX_FRAGMENT_DATA_BYTES &&
            length == FRAGMENT_RECORD_HEADER_BYTES + fragmentLength,
    ) { "Secure fragment bounds or ordering are invalid." }
    if (fragmentIndex == 0) {
      require(assembly == null) { "Secure messages overlap." }
      assembly = Assembly(messageId, fragmentCount, totalLength)
    }
    val open = assembly ?: error("Secure fragment did not start at index zero.")
    require(
        open.messageId == messageId &&
            open.fragmentCount == fragmentCount &&
            open.totalLength == totalLength &&
            open.nextFragment == fragmentIndex,
    ) { "Secure fragment sequence changed." }
    require(open.written + fragmentLength <= totalLength) {
      "Secure fragment exceeds its declared size."
    }
    plaintext.copyInto(
        open.bytes,
        open.written,
        FRAGMENT_RECORD_HEADER_BYTES,
        FRAGMENT_RECORD_HEADER_BYTES + fragmentLength,
    )
    open.written += fragmentLength
    open.nextFragment += 1
    if (open.nextFragment != fragmentCount) return null
    require(open.written == totalLength) { "Secure message length changed." }
    assembly = null
    expectedMessageId += 1
    return open.bytes
  }

  fun destroy() {
    assembly?.bytes?.fill(0)
    assembly = null
  }

  private data class Assembly(
      val messageId: Long,
      val fragmentCount: Int,
      val totalLength: Int,
      var nextFragment: Int = 0,
      var written: Int = 0,
      val bytes: ByteArray = ByteArray(totalLength),
  )
}
