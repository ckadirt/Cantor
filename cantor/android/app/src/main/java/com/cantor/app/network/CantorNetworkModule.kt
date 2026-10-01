package com.cantor.app.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Whether this phone has a connection at all — the one failure that is about
 * the whole app (docs/interfacealpha/folio.html#errors, F9c).
 *
 * `ConnectivityManager`'s default-network callback rather than a library: one
 * question, one system service. "Online" means the default network can reach
 * the internet and the system has validated that it does, so a captive portal
 * or a dead Wi-Fi reads as offline rather than as every node failing at once.
 */
class CantorNetworkModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  private val connectivity =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private var callback: ConnectivityManager.NetworkCallback? = null
  private var listeners = 0

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun current(promise: Promise) {
    promise.resolve(isOnline())
  }

  /** Required by `NativeEventEmitter`; the callback runs while anyone listens. */
  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
    listeners += 1
    if (callback != null) return
    val next =
        // Each callback says what it knows. Asking `activeNetwork` again from
        // `onLost` can still answer with the network being lost.
        object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) = emit(isOnline())

          override fun onLost(network: Network) = emit(false)

          override fun onCapabilitiesChanged(
              network: Network,
              capabilities: NetworkCapabilities,
          ) = emit(online(capabilities))
        }
    connectivity.registerDefaultNetworkCallback(next)
    callback = next
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    listeners = (listeners - count.toInt()).coerceAtLeast(0)
    if (listeners > 0) return
    callback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
    callback = null
  }

  override fun invalidate() {
    callback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
    callback = null
    super.invalidate()
  }

  private fun isOnline(): Boolean {
    val network = connectivity.activeNetwork ?: return false
    val capabilities = connectivity.getNetworkCapabilities(network) ?: return false
    return online(capabilities)
  }

  private fun online(capabilities: NetworkCapabilities): Boolean =
      capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

  private fun emit(online: Boolean) {
    if (!context.hasActiveReactInstance()) return
    val payload = Arguments.createMap().apply { putBoolean("online", online) }
    context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT, payload)
  }

  companion object {
    const val MODULE_NAME = "CantorNetwork"
    const val EVENT = "CantorNetworkChanged"
  }
}
