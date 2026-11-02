package com.cantor.app.security

import java.util.concurrent.ConcurrentHashMap
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/** Native prefixes on request ids: answers to these never reach JS. */
internal const val DOWNLOAD_ID_PREFIX = "xd-"
internal const val UPLOAD_ID_PREFIX = "xu-"
private val TRANSFER_ID = Regex("\"id\":\"(x[du]-\\d+-)\\d+\"")

/** What a link tells the app. Called from the socket's reader. */
internal interface RelayLinkEvents {
  fun opened()

  fun text(text: String)

  fun secureMessage(json: String)

  fun secureFailure(message: String)

  fun closed(code: Int, reason: String)
}

/**
 * One socket to the relay, owned here rather than by JS.
 *
 * Every secure frame is decrypted on this socket's reader and every outbound
 * record is encrypted beside the send that carries it, so audio never has to
 * cross into JS and back, and JS sees only finished control messages. Text
 * frames, the handshake and keepalive included, still belong to JS.
 */
internal class RelayLink(
    url: String,
    client: OkHttpClient,
    private val events: RelayLinkEvents,
) : WebSocketListener(), TransferWire {
  private val socket: WebSocket = client.newWebSocket(Request.Builder().url(url).build(), this)
  private val sending = Any()
  private val pumps = ConcurrentHashMap<String, TransferPump>()
  @Volatile private var channel: SecureChannel? = null

  fun attach(channel: SecureChannel) {
    this.channel = channel
  }

  /** The channel ended; frames and transfers on it end with it. */
  fun detach(ended: SecureChannel) {
    if (channel !== ended) return
    channel = null
    failTransfers(TransferFailure("disconnected", "The secure channel closed."))
  }

  fun sendText(text: String): Boolean = socket.send(text)

  /** Encrypts and sends together: records must reach the wire in nonce order. */
  override fun sendControl(json: ByteArray) {
    val inner = InnerCodec.encodeControl(json)
    sendInner(inner)
    inner.fill(0)
  }

  override fun sendInner(inner: ByteArray) {
    val secure = channel ?: throw IllegalStateException("Secure transport is not ready.")
    synchronized(sending) {
      for (ciphertext in secure.encrypt(inner)) {
        check(socket.send(InnerCodec.encodeCarrier(ciphertext).toByteString())) {
          "The relay connection closed."
        }
      }
    }
  }

  override fun backlogBytes(): Long = socket.queueSize()

  fun close(code: Int, reason: String) {
    if (!socket.close(code, reason)) socket.cancel()
  }

  fun register(prefix: String, pump: TransferPump) {
    pumps[prefix] = pump
  }

  fun unregister(prefix: String) {
    pumps.remove(prefix)
  }

  fun checkStalledTransfers() {
    pumps.values.forEach { it.checkStalled() }
  }

  private fun failTransfers(failure: Throwable) {
    pumps.values.forEach { it.fail(failure) }
  }

  override fun onOpen(webSocket: WebSocket, response: Response) = events.opened()

  override fun onMessage(webSocket: WebSocket, text: String) = events.text(text)

  override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
    val secure = channel
    if (secure == null) {
      events.secureFailure("Node sent encrypted data before the secure channel opened.")
      return
    }
    try {
      val frame = bytes.toByteArray()
      val length = InnerCodec.carrierLength(frame)
      val inner = secure.decrypt(frame, frame.size - length, length) ?: return
      when (val message = InnerCodec.decodeNode(inner)) {
        is Inner.Chunk -> pumpFor(message.requestId)?.onChunk(message)
        is Inner.Control -> {
          // Only transfer traffic pays for a parse here; everything else is JS's.
          val match = TRANSFER_ID.find(message.json.take(ID_WINDOW))
          if (match == null) events.secureMessage(message.json)
          else pumps[match.groupValues[1]]?.onControl(JSONObject(message.json))
        }
      }
    } catch (error: Exception) {
      events.secureFailure("Secure channel failed: ${error.message}")
    }
  }

  private fun pumpFor(requestId: String): TransferPump? =
      pumps[requestId.substring(0, requestId.lastIndexOf('-') + 1)]

  override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
    webSocket.close(code, null)
  }

  override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
    failTransfers(TransferFailure("disconnected", "The node reconnected."))
    events.closed(code, reason)
  }

  override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
    failTransfers(TransferFailure("disconnected", "The node reconnected."))
    events.closed(CLOSED_ABNORMALLY, failure.message ?: "Relay connection failed.")
  }

  private companion object {
    const val CLOSED_ABNORMALLY = 1006
    /** Answers carry their id near the front; a slice of JSON is enough. */
    const val ID_WINDOW = 128
  }
}
