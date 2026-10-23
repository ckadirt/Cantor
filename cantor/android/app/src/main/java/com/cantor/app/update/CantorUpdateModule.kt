package com.cantor.app.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Updating Cantor in place (internal/docs/plans/app-updates-plan.md, U5).
 *
 * The app learns of a newer version from cantorfm.com/app/latest.json (JS);
 * this module does the parts only Android can: download the APK, prove it is
 * the file the manifest named (its SHA-256 and size), prove it is an update
 * to *this* app (same package, higher versionCode, signed by the same
 * certificate as the running app), and hand it to Android's installer.
 * Android always asks the user to confirm; a sideloaded app cannot update
 * itself silently. The same key keeps the app's data across the update.
 */
class CantorUpdateModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  private val worker = Executors.newSingleThreadExecutor()
  private val cancelled = AtomicBoolean(false)
  private var receiver: BroadcastReceiver? = null

  override fun getName(): String = MODULE_NAME

  /** `{ applicationId, versionCode, versionName }` of the running app. */
  @ReactMethod
  fun current(promise: Promise) {
    val info = installed()
    promise.resolve(
        Arguments.createMap().apply {
          putString("applicationId", context.packageName)
          putDouble("versionCode", codeOf(info).toDouble())
          putString("versionName", info.versionName ?: "")
        })
  }

  /** Whether Android lets Cantor install apps (asked once, per app, from Android 8). */
  @ReactMethod
  fun canInstall(promise: Promise) {
    promise.resolve(
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            context.packageManager.canRequestPackageInstalls())
  }

  /** Opens Android's page where the user allows Cantor to install apps. */
  @ReactMethod
  fun allowInstall(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(true)
      return
    }
    val intent =
        Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
        .onSuccess { promise.resolve(true) }
        .onFailure { promise.reject("allow_failed", it.message, it) }
  }

  /**
   * Downloads `url` into the app's cache, resuming a partial file, and
   * resolves with its path once its size is `bytes` and its SHA-256 is
   * `sha256`. Progress arrives as [EVENT_PROGRESS] `{ received, total }`.
   */
  @ReactMethod
  fun download(url: String, sha256: String, bytes: Double, promise: Promise) {
    cancelled.set(false)
    worker.execute {
      try {
        val total = bytes.toLong()
        val dir = File(context.cacheDir, DIRECTORY).apply { mkdirs() }
        val name = "cantor-${sha256.take(12)}.apk"
        val done = File(dir, name)
        if (done.isFile && done.length() == total && sha256Of(done) == sha256.lowercase()) {
          emitProgress(total, total)
          promise.resolve(done.absolutePath)
          return@execute
        }
        // Anything else in the folder is an older download: it goes.
        dir.listFiles()?.forEach { if (it.name != "$name.part") it.delete() }
        val part = File(dir, "$name.part")
        var received = if (part.isFile && part.length() < total) part.length() else 0L
        if (received == 0L) part.delete()

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
          connectTimeout = 20_000
          readTimeout = 30_000
          instanceFollowRedirects = true
          if (received > 0) setRequestProperty("Range", "bytes=$received-")
        }
        val status = connection.responseCode
        if (status != 200 && status != 206) {
          throw UpdateError("download_failed", "The download answered $status.")
        }
        // A server that ignores the range sends the whole file again.
        if (received > 0 && status == 200) {
          part.delete()
          received = 0
        }
        connection.inputStream.use { input ->
          FileOutputStream(part, received > 0).use { output ->
            val buffer = ByteArray(64 * 1024)
            var lastEmit = 0L
            while (true) {
              if (cancelled.get()) throw UpdateError("cancelled", "The download was cancelled.")
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              received += read
              if (received - lastEmit >= 256 * 1024 || received == total) {
                lastEmit = received
                emitProgress(received, total)
              }
            }
          }
        }
        connection.disconnect()
        if (part.length() != total) {
          part.delete()
          throw UpdateError("size_mismatch", "The download is ${part.length()} bytes, not $total.")
        }
        if (sha256Of(part) != sha256.lowercase()) {
          part.delete()
          throw UpdateError("checksum_mismatch", "The download is not the file the update named.")
        }
        if (!part.renameTo(done)) throw UpdateError("download_failed", "The download could not be kept.")
        emitProgress(total, total)
        promise.resolve(done.absolutePath)
      } catch (error: UpdateError) {
        promise.reject(error.code, error.message, error)
      } catch (error: Exception) {
        promise.reject("download_failed", error.message ?: "The download failed.", error)
      }
    }
  }

  /** Stops a download in flight; its partial file stays, to resume. */
  @ReactMethod
  fun cancel(promise: Promise) {
    cancelled.set(true)
    promise.resolve(true)
  }

  /**
   * Proves the file at `path` is an update to this app: the same package, a
   * higher versionCode, and signed by the same certificate. Resolves with
   * `{ versionCode, versionName }`.
   */
  @ReactMethod
  fun verify(path: String, promise: Promise) {
    worker.execute {
      try {
        val archive = archiveInfo(path)
            ?: throw UpdateError("not_an_app", "The download is not an Android app.")
        if (archive.packageName != context.packageName) {
          throw UpdateError("wrong_app", "The download is ${archive.packageName}, not this app.")
        }
        val running = installed()
        if (codeOf(archive) <= codeOf(running)) {
          throw UpdateError("not_newer", "The download is not newer than this app.")
        }
        val theirs = certificates(archive)
        val ours = certificates(running)
        if (theirs.isEmpty() || theirs != ours) {
          throw UpdateError("wrong_signer", "The download is not signed with Cantor's key.")
        }
        promise.resolve(
            Arguments.createMap().apply {
              putDouble("versionCode", codeOf(archive).toDouble())
              putString("versionName", archive.versionName ?: "")
            })
      } catch (error: UpdateError) {
        promise.reject(error.code, error.message, error)
      } catch (error: Exception) {
        promise.reject("verify_failed", error.message ?: "The download could not be checked.", error)
      }
    }
  }

  /**
   * Hands the APK at `path` to Android's installer. The outcome arrives as
   * [EVENT_INSTALL] `{ status: confirm | installed | cancelled | failed,
   * message? }`; on success Android restarts the app as the new version.
   */
  @ReactMethod
  fun install(path: String, promise: Promise) {
    worker.execute {
      try {
        listenForResult()
        val installer = context.packageManager.packageInstaller
        val params =
            PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
              setAppPackageName(context.packageName)
            }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
          val file = File(path)
          FileInputStream(file).use { input ->
            session.openWrite("cantor.apk", 0, file.length()).use { output ->
              input.copyTo(output)
              session.fsync(output)
            }
          }
          val intent = Intent(ACTION_RESULT).setPackage(context.packageName)
          val flags =
              PendingIntent.FLAG_UPDATE_CURRENT or
                  // Android writes the result into the intent, so it must be mutable.
                  (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
          val pending = PendingIntent.getBroadcast(context, id, intent, flags)
          session.commit(pending.intentSender)
        }
        promise.resolve(true)
      } catch (error: Exception) {
        promise.reject("install_failed", error.message ?: "The installer could not start.", error)
      }
    }
  }

  /** Removes downloaded updates. */
  @ReactMethod
  fun clear(promise: Promise) {
    File(context.cacheDir, DIRECTORY).deleteRecursively()
    promise.resolve(true)
  }

  /** Required by `NativeEventEmitter`. */
  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  override fun invalidate() {
    receiver?.let { runCatching { context.unregisterReceiver(it) } }
    receiver = null
    worker.shutdownNow()
    super.invalidate()
  }

  // ---- the installer's answer --------------------------------------------------

  private fun listenForResult() {
    if (receiver != null) return
    val next =
        object : BroadcastReceiver() {
          override fun onReceive(context: Context, intent: Intent) {
            when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
              // Android needs the user's yes: show its dialog.
              PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm != null) {
                  context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                  emitInstall("confirm", null)
                } else {
                  emitInstall("failed", "Android did not ask to confirm the update.")
                }
              }
              PackageInstaller.STATUS_SUCCESS -> emitInstall("installed", null)
              PackageInstaller.STATUS_FAILURE_ABORTED -> emitInstall("cancelled", null)
              else ->
                  emitInstall(
                      "failed",
                      intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                          ?: "Android could not install the update ($status).")
            }
          }
        }
    val filter = IntentFilter(ACTION_RESULT)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(next, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag") context.registerReceiver(next, filter)
    }
    receiver = next
  }

  // ---- package facts --------------------------------------------------------------

  private fun installed(): PackageInfo =
      context.packageManager.getPackageInfo(context.packageName, signingFlags())

  @Suppress("DEPRECATION")
  private fun archiveInfo(path: String): PackageInfo? =
      context.packageManager.getPackageArchiveInfo(path, signingFlags())

  @Suppress("DEPRECATION")
  private fun signingFlags(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES
      else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  private fun codeOf(info: PackageInfo): Long =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
      else info.versionCode.toLong()

  /** The SHA-256 of each certificate the package is signed with. */
  @Suppress("DEPRECATION")
  private fun certificates(info: PackageInfo): Set<String> {
    val signatures =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          val signing = info.signingInfo ?: return emptySet()
          if (signing.hasMultipleSigners()) signing.apkContentsSigners
          else signing.signingCertificateHistory
        } else info.signatures
    return signatures.orEmpty().map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
  }

  private fun sha256Of(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return hex(digest.digest())
  }

  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  // ---- events ----------------------------------------------------------------------

  private fun emitProgress(received: Long, total: Long) =
      emit(
          EVENT_PROGRESS,
          Arguments.createMap().apply {
            putDouble("received", received.toDouble())
            putDouble("total", total.toDouble())
          })

  private fun emitInstall(status: String, message: String?) =
      emit(
          EVENT_INSTALL,
          Arguments.createMap().apply {
            putString("status", status)
            if (message != null) putString("message", message)
          })

  private fun emit(event: String, payload: WritableMap) {
    if (!context.hasActiveReactInstance()) return
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, payload)
  }

  private class UpdateError(val code: String, message: String) : Exception(message)

  companion object {
    const val MODULE_NAME = "CantorUpdate"
    const val EVENT_PROGRESS = "CantorUpdateProgress"
    const val EVENT_INSTALL = "CantorUpdateInstall"
    private const val ACTION_RESULT = "com.cantor.app.update.RESULT"
    private const val DIRECTORY = "updates"
  }
}
