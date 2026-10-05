package com.cantor.app

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Cantor"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        override fun loadApp(appKey: String?) {
          val app = application as MainApplication
          val surface = app.playbackSurface.attach(app.reactHost, this@MainActivity, requireNotNull(appKey))
          setReactSurface(surface)
          if (!surface.isRunning) surface.start()
          setContentView(surface.view)
        }

        override fun onDestroy() {
          // The delegate must release its Activity, but not stop the retained
          // surface: that would unmount the unchanged queue and audio element.
          reactDelegate?.setReactSurface(null)
          (application as MainApplication).playbackSurface.detach(this@MainActivity)
          super.onDestroy()
        }
      }
}
