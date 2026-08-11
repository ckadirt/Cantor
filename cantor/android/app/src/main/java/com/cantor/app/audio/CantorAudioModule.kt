package com.cantor.app.audio

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap

private const val MODULE_NAME = "CantorAudio"

class CantorAudioModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private val storage = AudioStorage(context.noBackupFilesDir, context.cacheDir)
  private val playback = AudioPlayback(lock)

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
        storage.removeCached(
            nodeKey,
            songId,
            digest,
            playback.playingPath,
            playback::stop,
        )
      }
    }
  }

  @ReactMethod
  fun play(nodeKey: String, songId: String, digest: String, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        val audio = storage.playableFile(nodeKey, songId, digest)
        playback.play(audio)
        storage.touch(audio)
        true
      }
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        playback.stop()
        true
      }
    }
  }

  @ReactMethod
  fun enforceCacheBudget(maxBytes: Double, promise: Promise) {
    runPromise(promise) {
      synchronized(lock) {
        WritableNativeArray().apply {
          storage
              .enforceCacheBudget(maxBytes, playback.playingPath)
              .forEach(::pushString)
        }
      }
    }
  }

  override fun invalidate() {
    synchronized(lock) { playback.stop() }
    super.invalidate()
  }

  private inline fun runPromise(promise: Promise, operation: () -> Any?) {
    try {
      promise.resolve(operation())
    } catch (error: Throwable) {
      promise.reject("E_CANTOR_AUDIO", error.message ?: "Audio operation failed.", error)
    }
  }
}
