package com.cantor.app.security

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.view.WindowManager
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

private const val RECOVERY_REQUEST = 4157

/** Keeps recovery words out of screenshots and asks Android to verify the owner. */
class CantorRecoveryModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
  private var pending: Promise? = null
  private val resultListener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != RECOVERY_REQUEST) return
      val promise = pending ?: return
      pending = null
      if (resultCode == Activity.RESULT_OK) promise.resolve(true)
      else promise.reject("CANCELLED", "Device authentication was cancelled.")
    }
  }

  init {
    context.addActivityEventListener(resultListener)
  }

  override fun getName() = "CantorRecovery"

  @ReactMethod
  fun setScreenProtected(enabled: Boolean, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "Cantor is not in the foreground.")
      return
    }
    activity.runOnUiThread {
      if (enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun authenticate(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "Cantor is not in the foreground.")
      return
    }
    val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    if (!keyguard.isDeviceSecure) {
      promise.reject("NO_DEVICE_LOCK", "Set a screen lock before revealing recovery words.")
      return
    }
    activity.runOnUiThread {
      if (pending != null) {
        promise.reject("IN_PROGRESS", "Device authentication is already open.")
        return@runOnUiThread
      }
      val intent = keyguard.createConfirmDeviceCredentialIntent(
          "Reveal recovery words",
          "Confirm your screen lock to view Cantor's recovery words.",
      )
      if (intent == null) {
        promise.reject("UNAVAILABLE", "Device authentication is unavailable.")
        return@runOnUiThread
      }
      pending = promise
      try {
        activity.startActivityForResult(intent, RECOVERY_REQUEST)
      } catch (error: Exception) {
        pending = null
        promise.reject("UNAVAILABLE", "Device authentication is unavailable.", error)
      }
    }
  }

  override fun invalidate() {
    pending?.reject("CANCELLED", "Recovery screen closed.")
    pending = null
    val activity = reactApplicationContext.currentActivity
    activity?.runOnUiThread {
      activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    super.invalidate()
  }
}
