package com.cantor.app.transport

import android.app.Application
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Android build never runs the JavaScript generator, so this test is the
 * native module's own proof that its constants still say what
 * `protocol/transport/v1/spec.json` says. Robolectric supplies the real
 * `org.json` implementation the stubbed unit-test runtime lacks.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, manifest = Config.NONE, sdk = [35])
class GeneratedTransportTest {
  @Test
  fun generatedConstantsMatchTheSharedManifest() {
    val spec = manifest()
    val noise = spec.getJSONObject("noise")
    val kinds = spec.getJSONObject("kinds")
    val headers = spec.getJSONObject("headers")
    val sizes = spec.getJSONObject("sizes")
    val bounds = spec.getJSONObject("bounds")

    assertEquals(
        spec.getJSONObject("versions").getInt("secure_record"),
        GeneratedTransport.SECURE_RECORD_VERSION.toInt(),
    )
    assertEquals(noise.getString("protocol_name"), GeneratedTransport.NOISE_PROTOCOL_NAME)
    assertEquals(
        noise.getInt("authentication_tag_bytes"),
        GeneratedTransport.NOISE_AUTHENTICATION_TAG_BYTES,
    )
    assertEquals(kinds.getInt("fragment_record"), GeneratedTransport.FRAGMENT_RECORD_KIND.toInt())
    assertEquals(
        headers.getInt("fragment_record_bytes"),
        GeneratedTransport.FRAGMENT_RECORD_HEADER_BYTES,
    )
    assertEquals(sizes.getInt("x25519_key_bytes"), GeneratedTransport.X25519_KEY_BYTES)
    assertEquals(
        bounds.getInt("handshake_message_bytes"),
        GeneratedTransport.MAX_HANDSHAKE_MESSAGE_BYTES,
    )
    assertEquals(
        bounds.getInt("noise_plaintext_bytes"),
        GeneratedTransport.MAX_NOISE_PLAINTEXT_BYTES,
    )
    assertEquals(
        bounds.getInt("secure_ciphertext_bytes"),
        GeneratedTransport.MAX_SECURE_CIPHERTEXT_BYTES,
    )
    assertEquals(bounds.getInt("logical_inner_bytes"), GeneratedTransport.MAX_LOGICAL_INNER_BYTES)
    assertEquals(bounds.getInt("artifact_chunk_bytes"), GeneratedTransport.ARTIFACT_CHUNK_BYTES)
    assertEquals(
        bounds.getLong("session_records_per_direction"),
        GeneratedTransport.MAX_SESSION_RECORDS_PER_DIRECTION,
    )
    assertEquals(
        bounds.getLong("session_ciphertext_bytes_per_direction"),
        GeneratedTransport.MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION,
    )
  }

  @Test
  fun derivedConstantsFollowTheManifestArithmetic() {
    val spec = manifest()
    val bounds = spec.getJSONObject("bounds")
    val headers = spec.getJSONObject("headers")
    val sizes = spec.getJSONObject("sizes")
    assertEquals(
        bounds.getInt("noise_plaintext_bytes") - headers.getInt("fragment_record_bytes"),
        GeneratedTransport.MAX_FRAGMENT_DATA_BYTES,
    )
    val prologue = spec.getJSONObject("domains").getString("secure_handshake_prologue")
    assertEquals(
        prologue.toByteArray(Charsets.UTF_8).size +
            Short.SIZE_BYTES +
            Byte.SIZE_BYTES +
            sizes.getInt("ed25519_public_key_bytes") +
            sizes.getInt("x25519_key_bytes") +
            sizes.getInt("channel_nonce_bytes"),
        GeneratedTransport.EXPECTED_PROLOGUE_BYTES,
    )
  }

  private fun manifest(): JSONObject {
    var directory: Path? = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
    while (directory != null) {
      val candidate = directory.resolve("protocol/transport/v1/spec.json")
      if (Files.isRegularFile(candidate)) {
        return JSONObject(String(Files.readAllBytes(candidate), Charsets.UTF_8))
      }
      directory = directory.parent
    }
    error("Cannot locate the transport manifest from ${System.getProperty("user.dir")}")
  }
}
