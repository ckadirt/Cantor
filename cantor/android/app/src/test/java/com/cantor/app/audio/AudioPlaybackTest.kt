package com.cantor.app.audio

import android.app.Application
import android.media.MediaPlayer
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, manifest = Config.NONE, sdk = [35])
class AudioPlaybackTest {
  @Test
  fun playConfiguresThePlayerAndStopReleasesIt() {
    val player = mock(MediaPlayer::class.java)
    val audio = File("/tmp/cantor-audio-fixture.opus")
    val playback = AudioPlayback(Any()) { player }

    playback.play(audio)

    verify(player).setDataSource(audio.absolutePath)
    verify(player).prepare()
    verify(player).start()
    assertEquals(audio.absolutePath, playback.playingPath)

    playback.stop()

    verify(player).stop()
    verify(player).release()
    assertNull(playback.playingPath)
  }

  @Test
  fun completionReleasesOnlyTheCurrentPlayer() {
    val first = mock(MediaPlayer::class.java)
    val second = mock(MediaPlayer::class.java)
    val players = ArrayDeque(listOf(first, second))
    val playback = AudioPlayback(Any()) { players.removeFirst() }
    val listener = ArgumentCaptor.forClass(MediaPlayer.OnCompletionListener::class.java)

    playback.play(File("/tmp/first.opus"))
    verify(first).setOnCompletionListener(listener.capture())
    val staleCompletion = listener.value
    playback.play(File("/tmp/second.opus"))

    staleCompletion.onCompletion(first)
    assertEquals(File("/tmp/second.opus").absolutePath, playback.playingPath)

    verify(second).setOnCompletionListener(listener.capture())
    listener.value.onCompletion(second)
    verify(second).release()
    assertNull(playback.playingPath)
  }
}
