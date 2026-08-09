package com.cantor.app.audio

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CantorAudioPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
      listOf(CantorAudioModule(context))

  override fun createViewManagers(
      context: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
