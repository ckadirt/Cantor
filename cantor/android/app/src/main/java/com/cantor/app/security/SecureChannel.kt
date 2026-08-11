package com.cantor.app.security

import android.util.Base64
import com.cantor.app.transport.GeneratedTransport.EXPECTED_PROLOGUE_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_FRAGMENT_DATA_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_HANDSHAKE_MESSAGE_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_LOGICAL_INNER_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_SECURE_CIPHERTEXT_BYTES
import com.cantor.app.transport.GeneratedTransport.MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION
import com.cantor.app.transport.GeneratedTransport.MAX_SESSION_RECORDS_PER_DIRECTION
import com.cantor.app.transport.GeneratedTransport.NOISE_AUTHENTICATION_TAG_BYTES
import com.cantor.app.transport.GeneratedTransport.NOISE_PROTOCOL_NAME
import com.cantor.app.transport.GeneratedTransport.X25519_KEY_BYTES
import com.southernstorm.noise.protocol.CipherStatePair
import com.southernstorm.noise.protocol.HandshakeState

/**
 * One initiator-side Noise channel: handshake, cipher states, per-direction
 * session limits, and the outbound message id. Keys and counters never leave
 * this object; callers see bounded byte copies.
 */
internal class SecureChannel private constructor(private var handshake: HandshakeState?) {
  private var ciphers: CipherStatePair? = null
  private var sendMessageId = 0L
  private var sentRecords = 0L
  private var receivedRecords = 0L
  private var sentBytes = 0L
  private var receivedBytes = 0L
  private val reassembler = FragmentReassembler()

  companion object {
    /**
     * Starts the NK handshake and returns the channel with its first message.
     * The caller owns encoding that message for the bridge.
     */
    fun begin(remotePublicKey: ByteArray, prologue: ByteArray): Pair<SecureChannel, ByteArray> {
      require(remotePublicKey.size == X25519_KEY_BYTES) {
        "Transport public key must contain $X25519_KEY_BYTES bytes."
      }
      require(prologue.size == EXPECTED_PROLOGUE_BYTES) { "Secure prologue has the wrong size." }
      val handshake = HandshakeState(NOISE_PROTOCOL_NAME, HandshakeState.INITIATOR)
      try {
        handshake.remotePublicKey.setPublicKey(remotePublicKey, 0)
        handshake.setPrologue(prologue, 0, prologue.size)
        handshake.start()
        require(handshake.action == HandshakeState.WRITE_MESSAGE) {
          "Noise initiator is in the wrong state."
        }
        val message = ByteArray(MAX_HANDSHAKE_MESSAGE_BYTES)
        try {
          val length = handshake.writeMessage(message, 0, null, 0, 0)
          require(length in 1..MAX_HANDSHAKE_MESSAGE_BYTES) {
            "Noise handshake message is invalid."
          }
          return SecureChannel(handshake) to message.copyOf(length)
        } finally {
          message.fill(0)
        }
      } catch (error: Throwable) {
        handshake.destroy()
        throw error
      }
    }
  }

  /**
   * Asserts the channel is still waiting for the responder's message. Callers
   * check this before decoding untrusted input so a wrong call sequence is
   * reported as a state error rather than an encoding error.
   */
  fun requireAwaitingHandshakeResponse() {
    val handshake = handshake ?: error("Secure handshake is already complete.")
    require(handshake.action == HandshakeState.READ_MESSAGE) {
      "Noise initiator is in the wrong state."
    }
  }

  /** Consumes the responder's message and splits into transport ciphers. */
  fun finish(message: ByteArray) {
    requireAwaitingHandshakeResponse()
    val handshake = handshake ?: error("Secure handshake is already complete.")
    require(message.size in 1..MAX_HANDSHAKE_MESSAGE_BYTES) {
      "Noise handshake response is outside its bound."
    }
    val empty = ByteArray(0)
    val payloadLength = handshake.readMessage(message, 0, message.size, empty, 0)
    require(payloadLength == 0 && handshake.action == HandshakeState.SPLIT) {
      "Noise handshake response carried unexpected data."
    }
    ciphers = handshake.split()
    this.handshake = null
    handshake.destroy()
  }

  /** Fragments and encrypts one inner message into base64 carrier records. */
  fun encrypt(inner: ByteArray): List<String> {
    require(inner.isNotEmpty() && inner.size <= MAX_LOGICAL_INNER_BYTES) {
      "Secure inner message is outside its bound."
    }
    require(sendMessageId <= 0xffff_ffffL) { "Secure send message id is exhausted; reconnect." }
    val fragmentCount = FragmentCodec.fragmentCount(inner.size)
    val output = mutableListOf<String>()
    var offset = 0
    for (index in 0 until fragmentCount) {
      val fragmentLength = minOf(MAX_FRAGMENT_DATA_BYTES, inner.size - offset)
      val record =
          FragmentCodec.encodeRecord(
              sendMessageId,
              index,
              fragmentCount,
              inner.size,
              inner,
              offset,
              fragmentLength,
          )
      val ciphertext = ByteArray(record.size + NOISE_AUTHENTICATION_TAG_BYTES)
      try {
        checkSendLimit(ciphertext.size)
        val length =
            requireCiphers().sender.encryptWithAd(null, record, 0, ciphertext, 0, record.size)
        require(length == ciphertext.size && length <= MAX_SECURE_CIPHERTEXT_BYTES) {
          "Noise ciphertext exceeded the carrier bound."
        }
        sentRecords += 1
        sentBytes += length
        output.add(Base64.encodeToString(ciphertext, 0, length, Base64.NO_WRAP))
      } finally {
        record.fill(0)
        ciphertext.fill(0)
      }
      offset += fragmentLength
    }
    sendMessageId += 1
    return output
  }

  /** Returns a complete inner message as base64, or null while reassembling. */
  fun decrypt(ciphertext: ByteArray): String? {
    require(
        ciphertext.size in (NOISE_AUTHENTICATION_TAG_BYTES + 1)..MAX_SECURE_CIPHERTEXT_BYTES,
    ) { "Noise ciphertext is outside the carrier bound." }
    checkReceiveLimit(ciphertext.size)
    val plaintext = ByteArray(ciphertext.size)
    try {
      val length =
          requireCiphers().receiver.decryptWithAd(null, ciphertext, 0, plaintext, 0, ciphertext.size)
      receivedRecords += 1
      receivedBytes += ciphertext.size
      return reassembler.accept(plaintext, length)?.let {
        try {
          Base64.encodeToString(it, Base64.NO_WRAP)
        } finally {
          it.fill(0)
        }
      }
    } finally {
      plaintext.fill(0)
    }
  }

  fun destroy() {
    handshake?.destroy()
    ciphers?.destroy()
    reassembler.destroy()
    handshake = null
    ciphers = null
  }

  private fun checkSendLimit(bytes: Int) {
    require(
        sentRecords < MAX_SESSION_RECORDS_PER_DIRECTION &&
            sentBytes + bytes <= MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION,
    ) { "Secure send key limit reached; reconnect." }
  }

  private fun checkReceiveLimit(bytes: Int) {
    require(
        receivedRecords < MAX_SESSION_RECORDS_PER_DIRECTION &&
            receivedBytes + bytes <= MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION,
    ) { "Secure receive key limit reached; reconnect." }
  }

  private fun requireCiphers(): CipherStatePair = ciphers ?: error("Secure handshake is not complete.")
}
