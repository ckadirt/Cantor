package com.cantor.app.security

import com.cantor.app.transport.GeneratedTransport.ARTIFACT_CHUNK_BYTES
import com.cantor.app.transport.GeneratedTransport.ARTIFACT_CHUNK_INNER_KIND
import com.cantor.app.transport.GeneratedTransport.ARTIFACT_INNER_FIXED_HEADER_BYTES
import com.cantor.app.transport.GeneratedTransport.CLIENT_CARRIER_HEADER_BYTES
import com.cantor.app.transport.GeneratedTransport.CONTROL_INNER_HEADER_BYTES
import com.cantor.app.transport.GeneratedTransport.CONTROL_INNER_KIND
import com.cantor.app.transport.GeneratedTransport.MAX_ARTIFACT_IDENTIFIER_UTF8_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_LOGICAL_INNER_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_SECURE_CIPHERTEXT_BYTES
import com.cantor.app.transport.GeneratedTransport.SECURE_CARRIER_KIND
import com.cantor.app.transport.GeneratedTransport.SECURE_CARRIER_VERSION
import com.cantor.app.transport.GeneratedTransport.SECURE_INNER_VERSION
import com.cantor.app.transport.GeneratedTransport.UPLOAD_CHUNK_INNER_KIND
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal sealed class Inner {
  data class Control(val json: String) : Inner()

  /** [data] is the whole inner message; the chunk is `[from, from + length)`. */
  class Chunk(
      val requestId: String,
      val transferId: String,
      val offset: Long,
      val data: ByteArray,
      val from: Int,
      val length: Int,
  ) : Inner()
}

/** Exact client carrier and logical inner framing. Knows nothing of Noise. */
internal object InnerCodec {
  fun encodeControl(json: ByteArray): ByteArray {
    require(json.isNotEmpty() && json.size + CONTROL_INNER_HEADER_BYTES <= MAX_LOGICAL_INNER_BYTES) {
      "Secure control message is outside its bound."
    }
    val inner = ByteArray(CONTROL_INNER_HEADER_BYTES + json.size)
    ByteBuffer.wrap(inner).order(ByteOrder.BIG_ENDIAN).apply {
      put(SECURE_INNER_VERSION)
      put(CONTROL_INNER_KIND)
      putInt(json.size)
      put(json)
    }
    return inner
  }

  /** One upload slice as raw bytes, laid out like an artifact chunk. */
  fun encodeUploadChunk(
      requestId: String,
      uploadId: String,
      offset: Long,
      data: ByteArray,
      length: Int,
  ): ByteArray {
    val id = requestId.toByteArray()
    val upload = uploadId.toByteArray()
    val inner = ByteArray(ARTIFACT_INNER_FIXED_HEADER_BYTES + id.size + upload.size + length)
    ByteBuffer.wrap(inner).order(ByteOrder.BIG_ENDIAN).apply {
      put(SECURE_INNER_VERSION)
      put(UPLOAD_CHUNK_INNER_KIND)
      putShort(id.size.toShort())
      put(id)
      putShort(upload.size.toShort())
      put(upload)
      putLong(offset)
      putInt(length)
      put(data, 0, length)
    }
    return inner
  }

  fun decodeNode(inner: ByteArray): Inner {
    require(inner.size >= 2 && inner.size <= MAX_LOGICAL_INNER_BYTES) {
      "Secure inner message is outside its bound."
    }
    require(inner[0] == SECURE_INNER_VERSION) { "Secure inner message has an unsupported version." }
    val buffer = ByteBuffer.wrap(inner).order(ByteOrder.BIG_ENDIAN)
    buffer.position(2)
    return when (inner[1]) {
      CONTROL_INNER_KIND -> decodeControl(inner, buffer)
      ARTIFACT_CHUNK_INNER_KIND -> decodeChunk(inner, buffer)
      else -> throw IllegalArgumentException("Secure inner message has an unsupported kind.")
    }
  }

  private fun decodeControl(inner: ByteArray, buffer: ByteBuffer): Inner {
    require(inner.size >= CONTROL_INNER_HEADER_BYTES) { "Secure control message is truncated." }
    require(inner.size == CONTROL_INNER_HEADER_BYTES + buffer.int) {
      "Secure control message length changed."
    }
    return Inner.Control(
        String(inner, CONTROL_INNER_HEADER_BYTES, inner.size - CONTROL_INNER_HEADER_BYTES),
    )
  }

  private fun decodeChunk(inner: ByteArray, buffer: ByteBuffer): Inner {
    val requestId = identifier(inner, buffer)
    val transferId = identifier(inner, buffer)
    require(buffer.remaining() >= 12) { "Secure artifact chunk is truncated." }
    val offset = buffer.long
    val length = buffer.int
    require(offset >= 0 && length in 1..ARTIFACT_CHUNK_BYTES && buffer.remaining() == length) {
      "Secure artifact chunk length changed."
    }
    return Inner.Chunk(requestId, transferId, offset, inner, buffer.position(), length)
  }

  private fun identifier(inner: ByteArray, buffer: ByteBuffer): String {
    require(buffer.remaining() >= 2) { "Secure artifact chunk is truncated." }
    val length = buffer.short.toInt() and 0xffff
    require(length in 1..MAX_ARTIFACT_IDENTIFIER_UTF8_BYTES && buffer.remaining() >= length) {
      "Secure artifact identifier is invalid."
    }
    val text = String(inner, buffer.position(), length)
    buffer.position(buffer.position() + length)
    return text
  }

  fun encodeCarrier(ciphertext: ByteArray): ByteArray {
    require(ciphertext.isNotEmpty() && ciphertext.size <= MAX_SECURE_CIPHERTEXT_BYTES) {
      "Secure ciphertext is outside the carrier bound."
    }
    val frame = ByteArray(CLIENT_CARRIER_HEADER_BYTES + ciphertext.size)
    ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN).apply {
      put(SECURE_CARRIER_VERSION)
      put(SECURE_CARRIER_KIND)
      putInt(ciphertext.size)
      put(ciphertext)
    }
    return frame
  }

  /** Validates [frame] and returns its ciphertext length. */
  fun carrierLength(frame: ByteArray): Int {
    require(frame.size >= CLIENT_CARRIER_HEADER_BYTES) { "Secure relay carrier is truncated." }
    val buffer = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
    val version = buffer.get()
    val kind = buffer.get()
    val length = buffer.int
    require(
        version == SECURE_CARRIER_VERSION &&
            kind == SECURE_CARRIER_KIND &&
            length in 1..MAX_SECURE_CIPHERTEXT_BYTES &&
            frame.size == CLIENT_CARRIER_HEADER_BYTES + length,
    ) { "Secure relay carrier is invalid." }
    return length
  }
}
