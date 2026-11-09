package com.cantor.app.export

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CantorExportPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
      listOf(CantorExportModule(context))

  override fun createViewManagers(
      context: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
