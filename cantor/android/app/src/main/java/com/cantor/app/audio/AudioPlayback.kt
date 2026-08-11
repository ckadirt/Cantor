package com.cantor.app.audio

import android.media.MediaPlayer
import java.io.File

internal class AudioPlayback(
    private val lock: Any,
    private val createPlayer: () -> MediaPlayer = ::MediaPlayer,
) {
  private var player: MediaPlayer? = null
  var playingPath: String? = null
    private set

  fun play(audio: File) {
    stop()
    val next = createPlayer()
    next.setDataSource(audio.absolutePath)
    next.setOnCompletionListener {
      synchronized(lock) {
        if (player === it) {
          it.release()
          player = null
          playingPath = null
        }
      }
    }
    next.prepare()
    next.start()
    player = next
    playingPath = audio.absolutePath
  }

  fun stop() {
    player?.runCatching { stop() }
    player?.release()
    player = null
    playingPath = null
  }
}
