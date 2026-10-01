package com.cantor.app

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.cantor.app.audio.CantorAudioPackage
import com.cantor.app.haptics.CantorHapticsPackage
import com.cantor.app.network.CantorNetworkPackage
import com.cantor.app.media.CantorMediaPackage
import com.cantor.app.security.CantorSecurePackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(CantorAudioPackage())
          add(CantorMediaPackage())
          add(CantorSecurePackage())
          add(CantorHapticsPackage())
          add(CantorNetworkPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
