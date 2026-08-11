package com.cantor.app.audio

import android.app.Application
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, manifest = Config.NONE, sdk = [35])
class AudioStorageTest {
  private lateinit var root: File
  private lateinit var storage: AudioStorage

  @Before
  fun setUp() {
    root = Files.createTempDirectory("cantor-audio-storage").toFile()
    storage = AudioStorage(File(root, "no-backup"), File(root, "cache"), syncDirectory = {})
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  @Test
  fun downloadPinUnpinAndRemovePreserveTheNativeStateMachine() {
    val bytes = "behavior-preserving audio".toByteArray()
    val digest = sha256(bytes)

    assertEquals(LocalAudioState("remote", 0.0), storage.localState(NODE, SONG_ONE, digest))
    assertEquals(
        bytes.size.toDouble(),
        storage.appendChunk(NODE, SONG_ONE, digest, 0.0, encoded(bytes)),
        0.0,
    )
    assertEquals(
        LocalAudioState("partial", bytes.size.toDouble()),
        storage.localState(NODE, SONG_ONE, digest),
    )

    assertTrue(storage.finalizeDownload(NODE, SONG_ONE, digest, bytes.size.toDouble()))
    assertEquals(
        LocalAudioState("cached", bytes.size.toDouble()),
        storage.localState(NODE, SONG_ONE, digest),
    )
    assertEquals(bytes.toList(), storage.playableFile(NODE, SONG_ONE, digest).readBytes().toList())

    assertTrue(storage.pin(NODE, SONG_ONE, digest))
    assertEquals("pinned", storage.localState(NODE, SONG_ONE, digest).state)
    assertThrows(IllegalArgumentException::class.java) {
      storage.removeCached(NODE, SONG_ONE, digest, null) {}
    }

    assertTrue(storage.unpin(NODE, SONG_ONE, digest))
    assertEquals("cached", storage.localState(NODE, SONG_ONE, digest).state)
    assertTrue(storage.removeCached(NODE, SONG_ONE, digest, null) {})
    assertEquals(LocalAudioState("remote", 0.0), storage.localState(NODE, SONG_ONE, digest))
  }

  @Test
  fun appendRequiresTheExactResumeOffsetAndKeepsThePartial() {
    val bytes = "resume".toByteArray()
    val digest = sha256(bytes)
    storage.appendChunk(NODE, SONG_ONE, digest, 0.0, encoded(bytes.copyOfRange(0, 3)))

    val error = assertThrows(IllegalArgumentException::class.java) {
      storage.appendChunk(NODE, SONG_ONE, digest, 2.0, encoded(bytes.copyOfRange(3, bytes.size)))
    }

    assertEquals("Partial artifact offset changed.", error.message)
    assertEquals(3.0, storage.localState(NODE, SONG_ONE, digest).bytes, 0.0)
  }

  @Test
  fun corruptFinalizationDeletesThePartialAndKeepsTheExactError() {
    val bytes = "corrupt".toByteArray()
    val claimedDigest = sha256("different".toByteArray())
    storage.appendChunk(NODE, SONG_ONE, claimedDigest, 0.0, encoded(bytes))

    val error = assertThrows(IllegalStateException::class.java) {
      storage.finalizeDownload(NODE, SONG_ONE, claimedDigest, bytes.size.toDouble())
    }

    assertEquals("Downloaded artifact digest does not match the node.", error.message)
    assertEquals(LocalAudioState("remote", 0.0), storage.localState(NODE, SONG_ONE, claimedDigest))
  }

  @Test
  fun cacheBudgetEvictsOldestDigestButProtectsThePlayingPath() {
    val first = "old".toByteArray()
    val second = "playing".toByteArray()
    val firstDigest = cache(SONG_ONE, first)
    val secondDigest = cache(SONG_TWO, second)
    val firstPath = storage.playableFile(NODE, SONG_ONE, firstDigest)
    val playingPath = storage.playableFile(NODE, SONG_TWO, secondDigest)
    assertTrue(firstPath.setLastModified(1_000L))
    assertTrue(playingPath.setLastModified(2_000L))

    val evicted = storage.enforceCacheBudget(second.size.toDouble(), playingPath.absolutePath)

    assertEquals(listOf(firstDigest), evicted)
    assertEquals("remote", storage.localState(NODE, SONG_ONE, firstDigest).state)
    assertEquals("cached", storage.localState(NODE, SONG_TWO, secondDigest).state)
    assertFalse(firstPath.exists())
    assertTrue(playingPath.exists())
  }

  @Test
  fun identifiersAndNumericBoundsKeepTheirExactValidation() {
    val digest = sha256(byteArrayOf(1))
    assertEquals(
        "Song id is invalid.",
        assertThrows(IllegalArgumentException::class.java) {
          storage.localState(NODE, "not-a-uuid", digest)
        }.message,
    )
    assertEquals(
        "Artifact digest is invalid.",
        assertThrows(IllegalArgumentException::class.java) {
          storage.localState(NODE, SONG_ONE, digest.uppercase())
        }.message,
    )
    assertEquals(
        "cache budget must be an integer.",
        assertThrows(IllegalArgumentException::class.java) {
          storage.enforceCacheBudget(1.5, null)
        }.message,
    )
  }

  private fun cache(songId: String, bytes: ByteArray): String {
    val digest = sha256(bytes)
    storage.appendChunk(NODE, songId, digest, 0.0, encoded(bytes))
    storage.finalizeDownload(NODE, songId, digest, bytes.size.toDouble())
    return digest
  }

  private fun encoded(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

  private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
      .digest(bytes)
      .joinToString("") { "%02x".format(it) }

  companion object {
    private const val NODE = "node-fixture"
    private const val SONG_ONE = "11111111-1111-4111-8111-111111111111"
    private const val SONG_TWO = "22222222-2222-4222-8222-222222222222"
  }
}
