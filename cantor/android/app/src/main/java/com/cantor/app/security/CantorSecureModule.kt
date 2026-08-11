package com.cantor.app.security

import android.util.Base64
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

private const val MODULE_NAME = "CantorSecure"

/** How many secure sessions one app process may keep open. Local policy. */
private const val MAX_CHANNELS = 16
private const val MAX_SESSION_ID_LENGTH = 256
private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")
private val BASE64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

/**
 * The React Native bridge for secure channels.
 *
 * This class owns only the session registry and the canonical base64 boundary.
 * Noise keys, nonce counters, and fragment state live in [SecureChannel]; the
 * relay only ever sees the binary ciphertext carrier assembled in TypeScript.
 * Any failure drops the session, so a broken channel is never reused.
 */
class CantorSecureModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private val channels = mutableMapOf<String, SecureChannel>()

  override fun getName(): String = MODULE_NAME

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun begin(sessionId: String, remotePublicKey: String, encodedPrologue: String): String =
      synchronized(lock) {
        require(sessionId.isNotEmpty() && sessionId.length <= MAX_SESSION_ID_LENGTH) {
          "Secure session id is invalid."
        }
        require(channels.containsKey(sessionId) || channels.size < MAX_CHANNELS) {
          "Too many secure sessions are open."
        }
        drop(sessionId)
        val remote = decodeBase64Url(remotePublicKey, "transport public key")
        val prologue = decodeBase64(encodedPrologue, "secure prologue")
        try {
          val (channel, message) = SecureChannel.begin(remote, prologue)
          try {
            channels[sessionId] = channel
            encodeBase64Url(message)
          } finally {
            message.fill(0)
          }
        } finally {
          remote.fill(0)
          prologue.fill(0)
        }
      }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun finish(sessionId: String, encodedMessage: String): Boolean = synchronized(lock) {
    val channel = requireChannel(sessionId)
    try {
      channel.requireAwaitingHandshakeResponse()
      val message = decodeBase64Url(encodedMessage, "Noise handshake response")
      try {
        channel.finish(message)
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
        org.json.JSONArray(channel.encrypt(inner)).toString()
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
        channel.decrypt(ciphertext)
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

  private fun requireChannel(sessionId: String): SecureChannel =
      channels[sessionId] ?: error("Secure session is not initialized.")

  private fun drop(sessionId: String) {
    channels.remove(sessionId)?.destroy()
  }
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
