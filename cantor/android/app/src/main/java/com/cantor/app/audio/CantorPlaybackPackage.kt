package com.cantor.app.audio

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
}
