package com.cantor.app.network

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CantorNetworkPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
      listOf(CantorNetworkModule(context))

  override fun createViewManagers(
      context: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
