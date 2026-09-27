package com.cantor.app.audio

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import java.util.concurrent.Executors

private const val MODULE_NAME = "CantorAudio"

class CantorAudioModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private val storage = AudioStorage(context.noBackupFilesDir, context.cacheDir)

  /**
   * Where reductions run. Its own thread, because a decode takes hundreds of
   * milliseconds and every other method here — `appendChunk` during a
   * download — would otherwise wait behind it on the module's queue. One
   * thread, so two reductions never compete for the decoder and the CPU.
   */
  private val reducer = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "CantorAudioReduce")
  }

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun localState(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val local = storage.localState(nodeKey, songId, digest)
        WritableNativeMap().apply {
          putString("state", local.state)
          putDouble("bytes", local.bytes)
        }
      }
    }
  }

  @ReactMethod
  fun appendChunk(
      nodeKey: String,
      songId: String,
      digest: String,
      expectedOffset: Double,
      encoded: String,
      promise: Promise,
  ) {
    runPromise(promise) {
      synchronized(lock) {
        storage.appendChunk(nodeKey, songId, digest, expectedOffset, encoded)
      }
    }
  }

  @ReactMethod
  fun finalizeDownload(
      nodeKey: String,
      songId: String,
      digest: String,
      expectedBytes: Double,
      promise: Promise,
  ) {
    runPromise(promise) {
      synchronized(lock) {
        storage.finalizeDownload(nodeKey, songId, digest, expectedBytes)
      }
    }
  }

  @ReactMethod
  fun pin(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) { storage.pin(nodeKey, songId, digest) }
    }
  }

  @ReactMethod
  fun unpin(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) { storage.unpin(nodeKey, songId, digest) }
    }
  }

  @ReactMethod
  fun removeCached(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        storage.removeCached(nodeKey, songId, digest)
      }
    }
  }

  @ReactMethod
  fun localPath(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) { storage.localPath(nodeKey, songId, digest) }
    }
  }

  /**
   * @param protectedPath the file the player currently holds, or null. Playback
   *   moved to JavaScript, so the caller is now the only thing that knows which
   *   file must survive eviction.
   */
  @ReactMethod
  fun enforceCacheBudget(maxBytes: Double, protectedPath: String?, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        WritableNativeArray().apply {
          storage.enforceCacheBudget(maxBytes, protectedPath).forEach(::pushString)
        }
      }
    }
  }

  /** A song's range reduced to columns; see `AudioReduction`. */
  @ReactMethod
  fun reduce(path: String, startSeconds: Double, endSeconds: Double, buckets: Double, promise: Promise) {
    reducer.execute {
      runPromise(promise) {
        val window = AudioReduction.reduce(path, startSeconds, endSeconds, buckets.toInt())
        WritableNativeMap().apply {
          putDouble("startSeconds", window.startSeconds)
          putDouble("endSeconds", window.endSeconds)
          putDouble("sampleRate", window.sampleRate.toDouble())
          putArray(
              "channels",
              WritableNativeArray().apply {
                for (c in window.min.indices) {
                  pushMap(
                      WritableNativeMap().apply {
                        putArray("min", floats(window.min[c]))
                        putArray("max", floats(window.max[c]))
                        putArray("rms", floats(window.rms[c]))
                      },
                  )
                }
              },
          )
          window.mid?.let { putArray("mid", floats(it)) }
          window.side?.let { putArray("side", floats(it)) }
        }
      }
    }
  }

  private fun floats(values: FloatArray): WritableNativeArray =
      WritableNativeArray().apply { values.forEach { pushDouble(it.toDouble()) } }

  private inline fun runPromise(promise: Promise, operation: () -> Any?) {
    try {
      promise.resolve(operation())
    } catch (error: Throwable) {
      promise.reject("E_CANTOR_AUDIO", error.message ?: "Audio operation failed.", error)
    }
  }
}
