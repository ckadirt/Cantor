package com.cantor.app.audio

import android.app.Activity
import android.content.Context
import android.content.MutableContextWrapper
import android.view.ViewGroup
import com.facebook.react.ReactHost
import com.facebook.react.interfaces.fabric.ReactSurface

/**
 * The existing React tree owns the player AND the shelf queue. Retain that tree
 * while a playback session exists, instead of replacing it with a native queue.
 * All methods run on the UI thread. No destroyed Activity is kept as a context.
 */
class PlaybackSurface(private val applicationContext: Context) {
  private var surface: ReactSurface? = null
  private var context: MutableContextWrapper? = null
  private var activity: Activity? = null
  private var sessionActive = false

  fun attach(host: ReactHost, owner: Activity, appKey: String): ReactSurface {
    activity = owner
    val retained = surface
    if (retained != null) {
      context?.baseContext = owner
      (retained.view?.parent as? ViewGroup)?.removeView(retained.view)
      return retained
    }
    val wrapper = MutableContextWrapper(owner)
    context = wrapper
    return host.createSurface(wrapper, appKey, null).also { surface = it }
  }

  fun detach(owner: Activity) {
    if (activity !== owner) return
    (surface?.view?.parent as? ViewGroup)?.removeView(surface?.view)
    activity = null
    context?.baseContext = applicationContext
    releaseIfIdle()
  }

  fun setSessionActive(active: Boolean) {
    sessionActive = active
    releaseIfIdle()
  }

  private fun releaseIfIdle() {
    if (activity != null || sessionActive) return
    surface?.stop()
    surface = null
    context = null
  }
}
