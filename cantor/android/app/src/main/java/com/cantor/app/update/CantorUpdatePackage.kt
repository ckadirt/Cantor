package com.cantor.app.update

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CantorUpdatePackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
      listOf(CantorUpdateModule(context))

  override fun createViewManagers(
      context: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
