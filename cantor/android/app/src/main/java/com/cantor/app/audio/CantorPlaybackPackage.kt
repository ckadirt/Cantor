package com.cantor.app.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import com.cantor.app.MainApplication
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.ViewManager

class CantorPlaybackPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(CantorPlaybackModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}

class CantorPlaybackModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
  override fun getName(): String = "CantorPlayback"

  @ReactMethod
  fun setSessionActive(active: Boolean, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      (context.applicationContext as MainApplication).playbackSurface.setSessionActive(active)
      promise.resolve(null)
    }
  }

  /**
   * Where media plays now, as the visual clock's latency table names it
   * (`src/player/outputLatency.ts`): speaker, wired, usb, bluetooth or other.
   */
  @ReactMethod
  fun outputRoute(promise: Promise) {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val type =
        if (Build.VERSION.SDK_INT >= 33) {
          val media =
              AudioAttributes.Builder()
                  .setUsage(AudioAttributes.USAGE_MEDIA)
                  .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                  .build()
          audio.getAudioDevicesForAttributes(media).firstOrNull()?.type
        } else {
          null
        }
    promise.resolve(
        when (type) {
          null -> legacyRoute(audio)
          AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
          AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "speaker"
          AudioDeviceInfo.TYPE_WIRED_HEADSET,
          AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
          AudioDeviceInfo.TYPE_LINE_ANALOG -> "wired"
          AudioDeviceInfo.TYPE_USB_HEADSET,
          AudioDeviceInfo.TYPE_USB_DEVICE,
          AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb"
          AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
          AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
          AudioDeviceInfo.TYPE_BLE_HEADSET,
          AudioDeviceInfo.TYPE_BLE_SPEAKER,
          AudioDeviceInfo.TYPE_BLE_BROADCAST,
          AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
          else -> "other"
        })
  }

  @Suppress("DEPRECATION")
  private fun legacyRoute(audio: AudioManager): String =
      when {
        audio.isBluetoothA2dpOn -> "bluetooth"
        audio.isWiredHeadsetOn -> "wired"
        else -> "speaker"
      }
}
