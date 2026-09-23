package com.cantor.app.security

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

@Suppress("DEPRECATION")
class CantorSecurePackage : ReactPackage {
  @Deprecated("Required by React Native's legacy package bridge.")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(CantorSecureModule(reactContext), CantorRecoveryModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
