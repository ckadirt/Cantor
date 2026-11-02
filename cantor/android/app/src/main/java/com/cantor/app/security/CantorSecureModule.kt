package com.cantor.app.security

import android.util.Base64
import com.cantor.app.audio.AudioStorage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

private const val MODULE_NAME = "CantorSecure"
private const val EVENT_NAME = "CantorRelay"
private const val STALL_CHECK_SECONDS = 1L
private const val CLOSE_GOING_AWAY = 1001

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
 * relay only ever sees the binary ciphertext carrier [RelayLink] assembles. Any
 * failure drops the session, so a broken channel is never reused.
 */
class CantorSecureModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private val channels = mutableMapOf<String, SecureChannel>()
  private val links = ConcurrentHashMap<Int, RelayLink>()
  private val storage by lazy { AudioStorage(context.noBackupFilesDir, context.cacheDir) }
  private val writes = Executors.newSingleThreadExecutor { Thread(it, "CantorTransferWrite") }
  private val watchdog = Executors.newSingleThreadScheduledExecutor { Thread(it, "CantorTransferWatch") }
  private val client: OkHttpClient by lazy {
    OkHttpClientProvider.createClient().newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .build()
  }

  init {
    watchdog.scheduleWithFixedDelay(
        { links.values.forEach { it.checkStalledTransfers() } },
        STALL_CHECK_SECONDS,
        STALL_CHECK_SECONDS,
        TimeUnit.SECONDS,
    )
  }

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

  /** Opens a socket; everything it does arrives as [EVENT_NAME] events. */
  @ReactMethod
  fun connect(linkId: Int, url: String) {
    links[linkId] = RelayLink(url, client, events(linkId))
  }

  @ReactMethod
  fun sendText(linkId: Int, text: String) {
    links[linkId]?.sendText(text)
  }

  @ReactMethod
  fun disconnect(linkId: Int, code: Int, reason: String) {
    links.remove(linkId)?.close(code, reason)
  }

  /** From here on the link's binary frames belong to this finished channel. */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun attach(linkId: Int, sessionId: String): Boolean = synchronized(lock) {
    requireLink(linkId).attach(requireChannel(sessionId))
    true
  }

  /** Encrypts and sends one application message, in call order. */
  @ReactMethod
  fun send(linkId: Int, sessionId: String, json: String) {
    val link = links[linkId] ?: return
    try {
      link.sendControl(json.toByteArray())
    } catch (error: Exception) {
      synchronized(lock) { drop(sessionId) }
      emit(linkId, "secureFailure", "Secure channel failed: ${error.message}")
    }
  }

  /** Pulls an artifact into its partial file; resolves once it is on disk. */
  @ReactMethod
  fun download(linkId: Int, options: ReadableMap, promise: Promise) {
    val link = links[linkId] ?: return promise.reject("disconnected", "The node is not connected.")
    val transfer = options.getInt("transfer")
    val prefix = "$DOWNLOAD_ID_PREFIX$transfer-"
    val nodeKey = options.getString("nodeKey")!!
    val songId = options.getString("songId")!!
    val digest = options.getString("digest")!!
    val pump =
        DownloadPump(
            wire = link,
            requestPrefix = prefix,
            transferId = options.getString("transferId")!!,
            protocolVersion = options.getInt("protocolVersion"),
            start = options.getDouble("offset").toLong(),
            byteLength = options.getDouble("byteLength").toLong(),
            chunkBytes = options.getInt("chunkBytes"),
            sha256 = digest,
            writer =
                object : ArtifactWriter {
                  override fun write(offset: Long, data: ByteArray, from: Int, length: Int) {
                    storage.appendBytes(nodeKey, songId, digest, offset, data, from, length)
                  }

                  override fun close() = storage.closePartial()
                },
            writes = writes,
            onProgress = { emitProgress(linkId, transfer, it) },
            onDone = { failure -> settle(link, prefix, promise, failure) },
        )
    link.register(prefix, pump)
    try {
      pump.start()
    } catch (error: Exception) {
      pump.fail(error)
    }
  }

  /** Sends a file's bytes from [offset]; resolves once the node has them all. */
  @ReactMethod
  fun upload(linkId: Int, options: ReadableMap, promise: Promise) {
    val link = links[linkId] ?: return promise.reject("disconnected", "The node is not connected.")
    val transfer = options.getInt("transfer")
    val prefix = "$UPLOAD_ID_PREFIX$transfer-"
    val file =
        try {
          RandomAccessFile(File(options.getString("path")!!), "r")
        } catch (error: Exception) {
          return promise.reject("internal", error.message ?: "The source file cannot be read.")
        }
    val pump =
        UploadPump(
            wire = link,
            requestPrefix = prefix,
            uploadId = options.getString("uploadId")!!,
            protocolVersion = options.getInt("protocolVersion"),
            start = options.getDouble("offset").toLong(),
            byteLength = options.getDouble("byteLength").toLong(),
            chunkBytes = options.getInt("chunkBytes"),
            binary = options.getBoolean("binary"),
            source =
                object : SourceReader {
                  override fun read(offset: Long, into: ByteArray, length: Int) {
                    file.seek(offset)
                    file.readFully(into, 0, length)
                  }

                  override fun close() = file.close()
                },
            onProgress = { emitProgress(linkId, transfer, it) },
            onDone = { failure -> settle(link, prefix, promise, failure) },
        )
    link.register(prefix, pump)
    Thread(pump, "CantorUpload").start()
  }

  private fun settle(link: RelayLink, prefix: String, promise: Promise, failure: Throwable?) {
    link.unregister(prefix)
    when (failure) {
      null -> promise.resolve(null)
      is TransferFailure -> promise.reject(failure.code, failure.message)
      else -> promise.reject("internal", failure.message ?: "The transfer failed.")
    }
  }

  private fun events(linkId: Int) =
      object : RelayLinkEvents {
        override fun opened() = emit(linkId, "open")

        override fun text(text: String) = emit(linkId, "text", text)

        override fun secureMessage(json: String) = emit(linkId, "secure", json)

        override fun secureFailure(message: String) = emit(linkId, "secureFailure", message)

        override fun closed(code: Int, reason: String) {
          links.remove(linkId)
          emit(linkId, "closed", reason) { putInt("code", code) }
        }
      }

  private fun emit(
      linkId: Int,
      kind: String,
      data: String? = null,
      extra: WritableMap.() -> Unit = {},
  ) {
    val event = Arguments.createMap()
    event.putInt("link", linkId)
    event.putString("kind", kind)
    data?.let { event.putString("data", it) }
    event.extra()
    reactApplicationContext.emitDeviceEvent(EVENT_NAME, event)
  }

  private fun emitProgress(linkId: Int, transfer: Int, bytes: Long) =
      emit(linkId, "progress") {
        putInt("transfer", transfer)
        putDouble("bytes", bytes.toDouble())
      }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun destroy(sessionId: String): Boolean = synchronized(lock) {
    drop(sessionId)
    true
  }

  override fun invalidate() {
    synchronized(lock) {
      for (link in links.values) link.close(CLOSE_GOING_AWAY, "app-reloaded")
      links.clear()
      for (channel in channels.values) channel.destroy()
      channels.clear()
    }
    watchdog.shutdownNow()
    writes.shutdown()
    super.invalidate()
  }

  /** The live channel of a session; the fixture corpus drives it directly. */
  internal fun requireChannel(sessionId: String): SecureChannel =
      channels[sessionId] ?: error("Secure session is not initialized.")

  private fun requireLink(linkId: Int): RelayLink =
      links[linkId] ?: error("Relay link is not open.")

  private fun drop(sessionId: String) {
    val channel = channels.remove(sessionId) ?: return
    links.values.forEach { it.detach(channel) }
    channel.destroy()
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
