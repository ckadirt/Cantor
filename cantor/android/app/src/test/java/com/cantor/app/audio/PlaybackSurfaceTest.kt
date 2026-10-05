package com.cantor.app.audio

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.MutableContextWrapper
import android.widget.FrameLayout
import com.facebook.react.ReactHost
import com.facebook.react.interfaces.fabric.ReactSurface
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.eq
import org.mockito.ArgumentMatchers.isNull
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, manifest = Config.NONE, sdk = [35])
class PlaybackSurfaceTest {
  @Test
  fun taskRemovalAndReopeningKeepTheSameSurfaceWithoutRetainingTheOldActivity() {
    val first = Robolectric.buildActivity(Activity::class.java).setup().get()
    val second = Robolectric.buildActivity(Activity::class.java).setup().get()
    val application = first.applicationContext
    val host = mock(ReactHost::class.java)
    val surface = mock(ReactSurface::class.java)
    lateinit var wrapper: MutableContextWrapper
    lateinit var view: FrameLayout
    `when`(host.createSurface((any(Context::class.java) ?: application), (eq("Cantor") ?: "Cantor"), isNull())).thenAnswer {
      wrapper = it.getArgument(0)
      view = FrameLayout(wrapper)
      `when`(surface.view).thenReturn(view)
      surface
    }
    val owner = PlaybackSurface(application)
    assertSame(surface, owner.attach(host, first, "Cantor"))
    FrameLayout(first).addView(view)
    owner.setSessionActive(true)
    owner.detach(first)
    assertNull(view.parent)
    assertSame(application, wrapper.baseContext)
    verify(surface, never()).stop()

    assertSame(surface, owner.attach(host, second, "Cantor"))
    assertSame(second, wrapper.baseContext)
    verify(host, times(1)).createSurface((any(Context::class.java) ?: application), (eq("Cantor") ?: "Cantor"), isNull())
    // A delayed destruction of the first Activity cannot detach the new one.
    owner.detach(first)
    assertSame(second, wrapper.baseContext)
    owner.setSessionActive(false)
    verify(surface, never()).stop()
    owner.detach(second)
    verify(surface, times(1)).stop()
  }

  @Test
  fun stoppingADetachedSessionReleasesTheSurfaceAndTheNextLaunchCreatesAFreshOne() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val application = activity.applicationContext
    val host = mock(ReactHost::class.java)
    val first = mock(ReactSurface::class.java)
    val second = mock(ReactSurface::class.java)
    `when`(host.createSurface((any(Context::class.java) ?: application), (eq("Cantor") ?: "Cantor"), isNull()))
        .thenReturn(first, second)
    val owner = PlaybackSurface(activity.applicationContext)
    owner.attach(host, activity, "Cantor")
    owner.setSessionActive(true)
    owner.detach(activity)
    owner.setSessionActive(false)
    owner.setSessionActive(false)
    verify(first, times(1)).stop()
    assertNotSame(first, owner.attach(host, activity, "Cantor"))
  }
}
