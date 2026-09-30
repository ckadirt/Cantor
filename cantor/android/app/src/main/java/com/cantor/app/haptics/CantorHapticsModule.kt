package com.cantor.app.haptics

import android.os.Build
import android.view.HapticFeedbackConstants
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Android's own haptic vocabulary, through the window's view.
 *
 * `View.performHapticFeedback` rather than the vibrator: the constants are the
 * system's, so each one feels the way the rest of the phone does and honours
 * the person's touch-feedback setting, and it needs no permission. The app
 * rations these to four places (docs/interfacealpha/folio-steps.md, F7).
 */
class CantorHapticsModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  override fun getName(): String = MODULE_NAME

  /** `tick`, `click` or `confirm`; anything else is ignored. */
  @ReactMethod
  fun perform(kind: String) {
    val constant = constantFor(kind) ?: return
    UiThreadUtil.runOnUiThread {
      reactApplicationContext.currentActivity?.window?.decorView?.performHapticFeedback(constant)
    }
  }

  private fun constantFor(kind: String): Int? =
      when (kind) {
        // A step along a dial, a ruler or a scrubbed number.
        "tick" ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
                HapticFeedbackConstants.SEGMENT_FREQUENT_TICK
            else HapticFeedbackConstants.CLOCK_TICK
        // A pulled blind crossing its release point.
        "click" ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE
            else HapticFeedbackConstants.CONTEXT_CLICK
        // The one firm pulse: `Make it`, and a held act completing.
        "confirm" ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                HapticFeedbackConstants.CONFIRM
            else HapticFeedbackConstants.LONG_PRESS
        else -> null
      }

  companion object {
    const val MODULE_NAME = "CantorHaptics"
  }
}
