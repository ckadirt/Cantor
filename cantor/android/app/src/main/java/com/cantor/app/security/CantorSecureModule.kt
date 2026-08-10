package com.cantor.app.security

import android.util.Base64
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.southernstorm.noise.protocol.CipherStatePair
import com.southernstorm.noise.protocol.HandshakeState
import java.nio.ByteBuffer
import java.nio.ByteOrder

private const val MODULE_NAME = "CantorSecure"
private const val NOISE_PROTOCOL = "Noise_NK_25519_ChaChaPoly_SHA256"
private const val CHANNEL_VERSION: Byte = 1
private const val RECORD_FRAGMENT: Byte = 1
private const val MAX_CHANNELS = 16
private const val MAX_HANDSHAKE_BYTES = 4 * 1024
private const val MAX_LOGICAL_BYTES = 1024 * 1024
private const val MAX_NOISE_PLAINTEXT_BYTES = 60 * 1024
private const val FRAGMENT_HEADER_BYTES = 18
private const val MAX_FRAGMENT_DATA_BYTES = MAX_NOISE_PLAINTEXT_BYTES - FRAGMENT_HEADER_BYTES
private const val MAX_CIPHERTEXT_BYTES = 96 * 1024
private const val MAX_SESSION_RECORDS = 1_000_000L
private const val MAX_SESSION_BYTES = 1024L * 1024L * 1024L
private const val EXPECTED_PROLOGUE_BYTES = 123
private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")
private val BASE64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

/**
 * Keeps Noise keys and nonce counters on the native side of the React Native
 * bridge. The bridge sees bounded base64 copies; the relay only sees the binary
 * ciphertext carrier assembled in TypeScript.
 */
class CantorSecureModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private val channels = mutableMapOf<String, Channel>()

  override fun getName(): String = MODULE_NAME

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun begin(sessionId: String, remotePublicKey: String, encodedPrologue: String): String =
      synchronized(lock) {
        require(sessionId.isNotEmpty() && sessionId.length <= 256) {
          "Secure session id is invalid."
        }
        require(channels.containsKey(sessionId) || channels.size < MAX_CHANNELS) {
          "Too many secure sessions are open."
        }
        drop(sessionId)
        val remote = decodeBase64Url(remotePublicKey, "transport public key")
        val prologue = decodeBase64(encodedPrologue, "secure prologue")
        require(remote.size == 32) { "Transport public key must contain 32 bytes." }
        require(prologue.size == EXPECTED_PROLOGUE_BYTES) { "Secure prologue has the wrong size." }
        val handshake = HandshakeState(NOISE_PROTOCOL, HandshakeState.INITIATOR)
        try {
          handshake.remotePublicKey.setPublicKey(remote, 0)
          handshake.setPrologue(prologue, 0, prologue.size)
          handshake.start()
          require(handshake.action == HandshakeState.WRITE_MESSAGE) {
            "Noise initiator is in the wrong state."
          }
          val message = ByteArray(MAX_HANDSHAKE_BYTES)
          try {
            val length = handshake.writeMessage(message, 0, null, 0, 0)
            require(length in 1..MAX_HANDSHAKE_BYTES) { "Noise handshake message is invalid." }
            channels[sessionId] = Channel(handshake = handshake)
            encodeBase64Url(message.copyOf(length))
          } finally {
            message.fill(0)
          }
        } catch (error: Throwable) {
          handshake.destroy()
          throw error
        } finally {
          remote.fill(0)
          prologue.fill(0)
        }
      }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun finish(sessionId: String, encodedMessage: String): Boolean = synchronized(lock) {
    val channel = requireChannel(sessionId)
    try {
      val handshake = channel.handshake ?: error("Secure handshake is already complete.")
      require(handshake.action == HandshakeState.READ_MESSAGE) {
        "Noise initiator is in the wrong state."
      }
      val message = decodeBase64Url(encodedMessage, "Noise handshake response")
      try {
        require(message.size in 1..MAX_HANDSHAKE_BYTES) {
          "Noise handshake response is outside its bound."
        }
        val empty = ByteArray(0)
        val payloadLength = handshake.readMessage(message, 0, message.size, empty, 0)
        require(payloadLength == 0 && handshake.action == HandshakeState.SPLIT) {
          "Noise handshake response carried unexpected data."
        }
        channel.ciphers = handshake.split()
        channel.handshake = null
        handshake.destroy()
        true
      } finally {
        message.fill(0)
      }
    } catch (error: Throwable) {
      drop(sessionId)
      throw error
    }
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun encrypt(sessionId: String, encodedInner: String): String = synchronized(lock) {
    val channel = requireChannel(sessionId)
    try {
      val inner = decodeBase64(encodedInner, "secure inner message")
      try {
        require(inner.isNotEmpty() && inner.size <= MAX_LOGICAL_BYTES) {
          "Secure inner message is outside its bound."
        }
        require(channel.sendMessageId <= 0xffff_ffffL) {
          "Secure send message id is exhausted; reconnect."
        }
        val fragmentCount = (inner.size + MAX_FRAGMENT_DATA_BYTES - 1) / MAX_FRAGMENT_DATA_BYTES
        require(fragmentCount in 1..0xffff) { "Secure message has too many fragments." }
        val output = mutableListOf<String>()
        var offset = 0
        for (index in 0 until fragmentCount) {
          val fragmentLength = minOf(MAX_FRAGMENT_DATA_BYTES, inner.size - offset)
          val record = ByteArray(FRAGMENT_HEADER_BYTES + fragmentLength)
          ByteBuffer.wrap(record).order(ByteOrder.BIG_ENDIAN).apply {
            put(CHANNEL_VERSION)
            put(RECORD_FRAGMENT)
            putInt(channel.sendMessageId.toInt())
            putShort(index.toShort())
            putShort(fragmentCount.toShort())
            putInt(inner.size)
            putInt(fragmentLength)
            put(inner, offset, fragmentLength)
          }
          val ciphertext = ByteArray(record.size + 16)
          try {
            checkSendLimit(channel, ciphertext.size)
            val length = requireCiphers(channel).sender.encryptWithAd(
                null,
                record,
                0,
                ciphertext,
                0,
                record.size,
            )
            require(length == ciphertext.size && length <= MAX_CIPHERTEXT_BYTES) {
              "Noise ciphertext exceeded the carrier bound."
            }
            channel.sentRecords += 1
            channel.sentBytes += length
            output.add(Base64.encodeToString(ciphertext, 0, length, Base64.NO_WRAP))
          } finally {
            record.fill(0)
            ciphertext.fill(0)
          }
          offset += fragmentLength
        }
        channel.sendMessageId += 1
        org.json.JSONArray(output).toString()
      } finally {
        inner.fill(0)
      }
    } catch (error: Throwable) {
      drop(sessionId)
      throw error
    }
  }

  /** Returns a complete inner message as base64, or null while reassembling. */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun decrypt(sessionId: String, encodedCiphertext: String): String? = synchronized(lock) {
    val channel = requireChannel(sessionId)
    try {
      val ciphertext = decodeBase64(encodedCiphertext, "Noise ciphertext")
      try {
        require(ciphertext.size in 17..MAX_CIPHERTEXT_BYTES) {
          "Noise ciphertext is outside the carrier bound."
        }
        checkReceiveLimit(channel, ciphertext.size)
        val plaintext = ByteArray(ciphertext.size)
        try {
          val length = requireCiphers(channel).receiver.decryptWithAd(
              null,
              ciphertext,
              0,
              plaintext,
              0,
              ciphertext.size,
          )
          channel.receivedRecords += 1
          channel.receivedBytes += ciphertext.size
          acceptFragment(channel, plaintext, length)?.let {
            try {
              Base64.encodeToString(it, Base64.NO_WRAP)
            } finally {
              it.fill(0)
            }
          }
        } finally {
          plaintext.fill(0)
        }
      } finally {
        ciphertext.fill(0)
      }
    } catch (error: Throwable) {
      drop(sessionId)
      throw error
    }
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun destroy(sessionId: String): Boolean = synchronized(lock) {
    drop(sessionId)
    true
  }

  override fun invalidate() {
    synchronized(lock) {
      for (channel in channels.values) channel.destroy()
      channels.clear()
    }
    super.invalidate()
  }

  private fun acceptFragment(channel: Channel, plaintext: ByteArray, length: Int): ByteArray? {
    require(length >= FRAGMENT_HEADER_BYTES) { "Secure fragment is truncated." }
    val buffer = ByteBuffer.wrap(plaintext, 0, length).order(ByteOrder.BIG_ENDIAN)
    require(buffer.get() == CHANNEL_VERSION && buffer.get() == RECORD_FRAGMENT) {
      "Secure fragment header is invalid."
    }
    val messageId = buffer.int.toLong() and 0xffff_ffffL
    val fragmentIndex = buffer.short.toInt() and 0xffff
    val fragmentCount = buffer.short.toInt() and 0xffff
    val totalLength = buffer.int
    val fragmentLength = buffer.int
    require(
        messageId == channel.receiveMessageId &&
            fragmentCount > 0 &&
            fragmentIndex < fragmentCount &&
            totalLength in 1..MAX_LOGICAL_BYTES &&
            fragmentLength in 1..MAX_FRAGMENT_DATA_BYTES &&
            length == FRAGMENT_HEADER_BYTES + fragmentLength,
    ) { "Secure fragment bounds or ordering are invalid." }
    if (fragmentIndex == 0) {
      require(channel.reassembly == null) { "Secure messages overlap." }
      channel.reassembly = Reassembly(messageId, fragmentCount, totalLength)
    }
    val assembly = channel.reassembly ?: error("Secure fragment did not start at index zero.")
    require(
        assembly.messageId == messageId &&
            assembly.fragmentCount == fragmentCount &&
            assembly.totalLength == totalLength &&
            assembly.nextFragment == fragmentIndex,
    ) { "Secure fragment sequence changed." }
    require(assembly.written + fragmentLength <= totalLength) {
      "Secure fragment exceeds its declared size."
    }
    plaintext.copyInto(
        assembly.bytes,
        assembly.written,
        FRAGMENT_HEADER_BYTES,
        FRAGMENT_HEADER_BYTES + fragmentLength,
    )
    assembly.written += fragmentLength
    assembly.nextFragment += 1
    if (assembly.nextFragment != fragmentCount) return null
    require(assembly.written == totalLength) { "Secure message length changed." }
    channel.reassembly = null
    channel.receiveMessageId += 1
    return assembly.bytes
  }

  private fun checkSendLimit(channel: Channel, bytes: Int) {
    require(
        channel.sentRecords < MAX_SESSION_RECORDS &&
            channel.sentBytes + bytes <= MAX_SESSION_BYTES,
    ) { "Secure send key limit reached; reconnect." }
  }

  private fun checkReceiveLimit(channel: Channel, bytes: Int) {
    require(
        channel.receivedRecords < MAX_SESSION_RECORDS &&
            channel.receivedBytes + bytes <= MAX_SESSION_BYTES,
    ) { "Secure receive key limit reached; reconnect." }
  }

  private fun requireChannel(sessionId: String): Channel =
      channels[sessionId] ?: error("Secure session is not initialized.")

  private fun requireCiphers(channel: Channel): CipherStatePair =
      channel.ciphers ?: error("Secure handshake is not complete.")

  private fun drop(sessionId: String) {
    channels.remove(sessionId)?.destroy()
  }

  private class Channel(
      var handshake: HandshakeState? = null,
      var ciphers: CipherStatePair? = null,
      var sendMessageId: Long = 0,
      var receiveMessageId: Long = 0,
      var sentRecords: Long = 0,
      var receivedRecords: Long = 0,
      var sentBytes: Long = 0,
      var receivedBytes: Long = 0,
      var reassembly: Reassembly? = null,
  ) {
    fun destroy() {
      handshake?.destroy()
      ciphers?.destroy()
      reassembly?.bytes?.fill(0)
      handshake = null
      ciphers = null
      reassembly = null
    }
  }

  private data class Reassembly(
      val messageId: Long,
      val fragmentCount: Int,
      val totalLength: Int,
      var nextFragment: Int = 0,
      var written: Int = 0,
      val bytes: ByteArray = ByteArray(totalLength),
  )
}

private fun decodeBase64Url(value: String, label: String): ByteArray {
  require(value.isNotEmpty() && BASE64URL.matches(value)) { "$label is not canonical base64url." }
  val bytes = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  require(encodeBase64Url(bytes) == value) { "$label is not canonical base64url." }
  return bytes
}

private fun encodeBase64Url(value: ByteArray): String =
    Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

private fun decodeBase64(value: String, label: String): ByteArray {
  require(value.isNotEmpty() && value.length % 4 == 0 && BASE64.matches(value)) {
    "$label is not canonical base64."
  }
  val bytes = Base64.decode(value, Base64.NO_WRAP)
  require(Base64.encodeToString(bytes, Base64.NO_WRAP) == value) {
    "$label is not canonical base64."
  }
  return bytes
}
