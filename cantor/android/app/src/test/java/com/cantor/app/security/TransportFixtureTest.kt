package com.cantor.app.security

import android.app.Application
import com.facebook.react.bridge.ReactApplicationContext
import com.southernstorm.noise.protocol.CipherStatePair
import com.southernstorm.noise.protocol.HandshakeState
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.mock
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val NOISE_PROTOCOL = "Noise_NK_25519_ChaChaPoly_SHA256"
private const val MAX_HANDSHAKE_BYTES = 4 * 1024

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, manifest = Config.NONE, sdk = [35])
class TransportFixtureTest {
  @Test
  fun nativeModuleEmitsAndConsumesTheSharedFragmentRecord() {
    val identity = fixture("identity.json")
    val fragment = fixture("fragment.json").getJSONObject("valid").getJSONObject("single_control")
    val channel = openChannel(identity, "fixture-roundtrip")
    try {
      val inner = fromHex(fragment.getString("inner_hex"))
      val encodedCiphertexts = channel.module.encrypt(
          channel.sessionId,
          Base64.getEncoder().encodeToString(inner),
      )
      val ciphertexts = org.json.JSONArray(encodedCiphertexts)
      assertEquals(1, ciphertexts.length())
      val outboundCiphertext = Base64.getDecoder().decode(ciphertexts.getString(0))
      assertArrayEquals(
          fromHex(fragment.getString("record_hex")),
          decrypt(channel.ciphers.receiver, outboundCiphertext),
      )

      val inboundCiphertext = encrypt(
          channel.ciphers.sender,
          fromHex(fragment.getString("record_hex")),
      )
      assertEquals(
          Base64.getEncoder().encodeToString(inner),
          channel.module.decrypt(
              channel.sessionId,
              Base64.getEncoder().encodeToString(inboundCiphertext),
          ),
      )
    } finally {
      channel.destroy()
    }
  }

  @Test
  fun nativeModuleRejectsTheSharedMalformedFragmentCorpus() {
    val identity = fixture("identity.json")
    val malformed = fixture("fragment.json").getJSONArray("malformed")
    for (index in 0 until malformed.length()) {
      val vector = malformed.getJSONObject(index)
      if (vector.getString("kotlin") != "reject") continue
      val channel = openChannel(identity, "fixture-malformed-$index")
      try {
        val ciphertext = encrypt(
            channel.ciphers.sender,
            fromHex(vector.getString("record_hex")),
        )
        assertThrows("fixture ${vector.getString("id")}", RuntimeException::class.java) {
          channel.module.decrypt(
              channel.sessionId,
              Base64.getEncoder().encodeToString(ciphertext),
          )
        }
      } finally {
        channel.destroy()
      }
    }
  }

  private fun openChannel(identity: JSONObject, sessionId: String): TestChannel {
    val descriptor = identity.getJSONObject("descriptor")
    val prologue = fromHex(identity.getString("handshake_prologue_hex"))
    val transportSecret = fromHex(identity.getString("transport_x25519_secret_hex"))
    val context = mock(ReactApplicationContext::class.java)
    val module = CantorSecureModule(context)
    val firstEncoded = module.begin(
        sessionId,
        descriptor.getString("transport_x25519"),
        Base64.getEncoder().encodeToString(prologue),
    )

    val responder = HandshakeState(NOISE_PROTOCOL, HandshakeState.RESPONDER)
    try {
      responder.localKeyPair.setPrivateKey(transportSecret, 0)
      responder.setPrologue(prologue, 0, prologue.size)
      responder.start()
      val first = Base64.getUrlDecoder().decode(firstEncoded)
      val empty = ByteArray(0)
      assertEquals(0, responder.readMessage(first, 0, first.size, empty, 0))
      val second = ByteArray(MAX_HANDSHAKE_BYTES)
      val secondLength = responder.writeMessage(second, 0, null, 0, 0)
      val secondEncoded = Base64.getUrlEncoder().withoutPadding().encodeToString(
          second.copyOf(secondLength),
      )
      module.finish(sessionId, secondEncoded)
      val ciphers = responder.split()
      return TestChannel(module, sessionId, ciphers)
    } catch (error: Throwable) {
      module.destroy(sessionId)
      throw error
    } finally {
      responder.destroy()
      prologue.fill(0)
      transportSecret.fill(0)
    }
  }

  private fun encrypt(
      cipher: com.southernstorm.noise.protocol.CipherState,
      plaintext: ByteArray,
  ): ByteArray {
    val output = ByteArray(plaintext.size + 16)
    val length = cipher.encryptWithAd(null, plaintext, 0, output, 0, plaintext.size)
    return output.copyOf(length)
  }

  private fun decrypt(
      cipher: com.southernstorm.noise.protocol.CipherState,
      ciphertext: ByteArray,
  ): ByteArray {
    val output = ByteArray(ciphertext.size)
    val length = cipher.decryptWithAd(null, ciphertext, 0, output, 0, ciphertext.size)
    return output.copyOf(length)
  }

  private fun fixture(name: String): JSONObject {
    var directory: Path? = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
    while (directory != null) {
      val candidate = directory.resolve("protocol/transport/v1/fixtures/$name")
      if (Files.isRegularFile(candidate)) {
        return JSONObject(String(Files.readAllBytes(candidate), Charsets.UTF_8))
      }
      directory = directory.parent
    }
    error("Cannot locate shared transport fixture $name from ${System.getProperty("user.dir")}")
  }

  private fun fromHex(value: String): ByteArray {
    require(value.length % 2 == 0 && value.matches(Regex("^[0-9a-f]*$"))) {
      "Fixture hex is not canonical."
    }
    return ByteArray(value.length / 2) { index ->
      value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }

  private data class TestChannel(
      val module: CantorSecureModule,
      val sessionId: String,
      val ciphers: CipherStatePair,
  ) {
    fun destroy() {
      module.destroy(sessionId)
      ciphers.destroy()
    }
  }
}
