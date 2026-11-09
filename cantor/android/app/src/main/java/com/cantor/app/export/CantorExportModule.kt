package com.cantor.app.export

import android.content.ClipData
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val MODULE_NAME = "CantorExport"

/** Prepared files live here, one directory per key, the file under its display name. */
private const val EXPORTS_DIR = "exports"

/** The folder under Music/ or Download/ that saved copies go into. */
private const val CANTOR_FOLDER = "Cantor"

private val KEY = Regex("^[A-Za-z0-9._-]{1,160}$")

/**
 * Taking a song out of Cantor as a file (internal/docs/plans/take-it-plan.md).
 *
 * Three acts, decided in JS and done here: **stage** a file to send (a copy of
 * the delivery audio with Cantor's tags and cover, in the app's cache), **share**
 * it (Android's share sheet, the file itself through a FileProvider), and
 * **save** it (a public copy through MediaStore). This is the only part of the
 * app that writes outside its own storage, and it only ever writes new files
 * into `Music/Cantor` or `Download/Cantor`, or overwrites a copy it made.
 *
 * Everything runs on its own thread: staging copies megabytes.
 */
class CantorExportModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
  private val worker = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "CantorExport")
  }

  private val exportsRoot: File
    get() = File(context.cacheDir, EXPORTS_DIR)

  override fun getName(): String = MODULE_NAME

  /**
   * Copy the delivery Opus at `source` to `exports/<key>/<name>` with its tags
   * replaced by `comments` (pairs, in order, the marker first) and the cover
   * PNG (base64) as its front-cover picture. A file already staged under the
   * same key is returned as it is: the key names its contents.
   */
  @ReactMethod
  fun stageOpus(
      source: String,
      key: String,
      name: String,
      comments: ReadableArray,
      cover: ReadableMap?,
      promise: Promise,
  ) {
    run(promise) {
      stage(source, key, name) { input, temporary ->
        val picture = coverPng(cover)?.let { (png, width, height) -> flacPicture(png, width, height) }
        rewriteOpusTags(input, temporary, pairs(comments), picture)
      }
    }
  }

  /**
   * Make an MP3 of the delivery audio at `source` (`Mp3Encoder`: LAME, on
   * several cores) and stage it as `exports/<key>/<name>`, with an ID3v2.4 tag
   * of `comments` (the marker first) and the cover last. Resolves with the
   * staged file and how long the encode took.
   */
  @ReactMethod
  fun stageMp3(
      source: String,
      key: String,
      name: String,
      comments: ReadableArray,
      cover: ReadableMap?,
      promise: Promise,
  ) {
    run(promise) {
      var encoded: Mp3Encoded? = null
      val result = stage(source, key, name) { input, temporary ->
        val frames = File(temporary.parentFile, ".${temporary.name}.frames")
        try {
          encoded = Mp3Encoder.encode(input.absolutePath, frames.absolutePath)
          temporary.outputStream().buffered().use { output ->
            output.write(id3v2Tag(pairs(comments), coverPng(cover)?.first))
            frames.inputStream().use { it.copyTo(output) }
          }
        } finally {
          frames.delete()
        }
      }
      encoded?.let {
        result.putDouble("encodeMs", it.milliseconds)
        result.putInt("segments", it.segments)
        // One line per MP3 made, so its cost can be read off a phone.
        Log.i(
            MODULE_NAME,
            "mp3 ${it.segments} segments, ${it.frames} frames, ${it.bytes} bytes, " +
                "${"%.0f".format(it.milliseconds)} ms decode + encode",
        )
      }
      result
    }
  }

  /**
   * Stage `exports/<key>/<name>`, made by `make(input, temporary)` unless a
   * file is already staged under the key: the key names its contents.
   */
  private fun stage(
      source: String,
      key: String,
      name: String,
      make: (input: File, temporary: File) -> Unit,
  ): WritableMap {
    require(KEY.matches(key)) { "Export key is invalid." }
    requireFileName(name)
    val directory = File(exportsRoot, key)
    val target = File(directory, name)
    if (!target.isFile) {
      val input = File(source)
      require(input.isFile) { "The song's audio is not on this phone." }
      directory.mkdirs()
      val temporary = File(directory, ".$name.part")
      try {
        make(input, temporary)
        check(temporary.renameTo(target)) { "The staged file could not be kept." }
      } finally {
        temporary.delete()
      }
    }
    directory.setLastModified(System.currentTimeMillis())
    return staged(target)
  }

  private fun pairs(comments: ReadableArray): List<Pair<String, String>> =
      (0 until comments.size()).map { index ->
        val pair = comments.getArray(index) ?: error("A tag is malformed.")
        (pair.getString(0) ?: error("A tag is malformed.")) to
            (pair.getString(1) ?: error("A tag is malformed."))
      }

  /** The cover's PNG bytes, width and height, or null. */
  private fun coverPng(cover: ReadableMap?): Triple<ByteArray, Int, Int>? =
      cover?.let {
        Triple(
            android.util.Base64.decode(it.getString("png"), android.util.Base64.DEFAULT),
            it.getInt("width"),
            it.getInt("height"),
        )
      }

  /**
   * Where the node's master is downloaded for `key`, and how much of it is
   * there already: a transfer resumes from the end of the file. `staged` is
   * the finished WAV when one is already staged under the key as `name`, so
   * it is not fetched again.
   */
  @ReactMethod
  fun masterPart(key: String, name: String, promise: Promise) {
    run(promise) {
      require(KEY.matches(key)) { "Export key is invalid." }
      requireFileName(name)
      val directory = File(exportsRoot, key)
      val part = File(directory, ".master.part")
      val done = File(directory, name)
      directory.mkdirs()
      Arguments.createMap().apply {
        putString("path", part.absolutePath)
        putDouble("bytes", if (part.isFile) part.length().toDouble() else 0.0)
        if (done.isFile) putMap("staged", staged(done)) else putNull("staged")
      }
    }
  }

  /**
   * Stage the downloaded master as `exports/<key>/<name>`, once its bytes are
   * the master's (`digest`), with Cantor's marker and `LIST/INFO` tags in it.
   * A part that does not match is deleted, so the next attempt starts clean.
   */
  @ReactMethod
  fun stageWav(
      part: String,
      digest: String,
      key: String,
      name: String,
      comments: ReadableArray,
      promise: Promise,
  ) {
    run(promise) {
      val downloaded = stagedFile(part)
      val actual = MessageDigest.getInstance("SHA-256").let { sha ->
        downloaded.inputStream().use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            sha.update(buffer, 0, read)
          }
        }
        sha.digest().joinToString("") { "%02x".format(it) }
      }
      if (actual != digest) {
        downloaded.delete()
        error("The master arrived damaged; it will be fetched again.")
      }
      val result = stage(downloaded.absolutePath, key, name) { input, temporary ->
        input.inputStream().buffered().use { source ->
          temporary.outputStream().buffered().use { output -> tagWav(source, output, pairs(comments)) }
        }
      }
      downloaded.delete()
      result
    }
  }

  /** Hand a staged file to Android's share sheet. Resolves once it is shown. */
  @ReactMethod
  fun share(path: String, mime: String, promise: Promise) {
    run(promise) {
      val file = stagedFile(path)
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.exports", file)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, file.name)
        // The receiving app reads the file through this grant, and the clip
        // is what makes the share sheet show it as a file preview.
        clipData = ClipData.newRawUri(file.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, null).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val activity = context.currentActivity
      if (activity != null) {
        activity.runOnUiThread { activity.startActivity(chooser) }
      } else {
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
      }
      null
    }
  }

  /**
   * Save a staged file as a public copy: `Music/Cantor` or `Download/Cantor`.
   * `replace` is the content URI of the copy it supersedes (the same song and
   * format, made from newer audio), overwritten in place when it still exists.
   * Resolves with where it went: its URI, and MediaStore's id and path.
   */
  @ReactMethod
  fun save(path: String, mime: String, destination: String, replace: String?, promise: Promise) {
    run(promise) {
      val file = stagedFile(path)
      require(destination == "music" || destination == "download") {
        "Unknown destination."
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        saveThroughMediaStore(file, mime, destination, replace)
      } else {
        saveToPublicFolder(file, destination)
      }
    }
  }

  /**
   * Whether each saved copy is still there: a content URI that still resolves
   * to a row, or a file that still exists. Asked when a song's sheet opens, so
   * a copy deleted in Files stops being reported as saved.
   */
  @ReactMethod
  fun present(uris: ReadableArray, promise: Promise) {
    run(promise) {
      val result = Arguments.createArray()
      for (index in 0 until uris.size()) {
        val uri = Uri.parse(uris.getString(index) ?: "")
        val there = when (uri.scheme) {
          "file" -> uri.path?.let { File(it).isFile } ?: false
          "content" -> try {
            context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null)
                ?.use { it.moveToFirst() } ?: false
          } catch (_: SecurityException) {
            // Not Cantor's to read any more (made before a reinstall): it
            // exists, which is all this asks.
            true
          } catch (_: IllegalArgumentException) {
            false
          }
          else -> false
        }
        result.pushBoolean(there)
      }
      result
    }
  }

  /**
   * Drop the oldest staged files until the rest fit in `maxBytes`. A share
   * target may still be reading the newest, so it is never dropped.
   */
  @ReactMethod
  fun prune(maxBytes: Double, promise: Promise) {
    run(promise) {
      val directories = exportsRoot.listFiles()?.filter { it.isDirectory } ?: emptyList()
      val sized = directories
          .map { it to (it.listFiles()?.sumOf { file -> file.length() } ?: 0L) }
          .sortedByDescending { it.first.lastModified() }
      var kept = 0L
      var removed = 0
      sized.forEachIndexed { index, (directory, bytes) ->
        if (index > 0 && kept + bytes > maxBytes.toLong()) {
          directory.deleteRecursively()
          removed += 1
        } else {
          kept += bytes
        }
      }
      removed
    }
  }

  private fun saveThroughMediaStore(
      file: File,
      mime: String,
      destination: String,
      replace: String?,
  ): WritableMap {
    val resolver = context.contentResolver
    if (replace != null) {
      val existing = Uri.parse(replace)
      val overwritten = try {
        resolver.openOutputStream(existing, "wt")?.use { output ->
          file.inputStream().use { it.copyTo(output) }
        } != null
      } catch (_: FileNotFoundException) {
        false
      } catch (_: SecurityException) {
        false
      }
      if (overwritten) return where(existing)
    }
    val collection = if (destination == "music") {
      MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }
    val folder = if (destination == "music") Environment.DIRECTORY_MUSIC else Environment.DIRECTORY_DOWNLOADS
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/$CANTOR_FOLDER")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, values) ?: error("Android would not make the file.")
    try {
      resolver.openOutputStream(uri, "w")?.use { output ->
        file.inputStream().use { it.copyTo(output) }
      } ?: error("Android would not open the file.")
      resolver.update(
          uri,
          ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
          null,
          null,
      )
    } catch (error: Throwable) {
      resolver.delete(uri, null, null)
      throw error
    }
    return where(uri)
  }

  /** Android 7–9: a plain file in the public folder, then a scan to index it. */
  @Suppress("DEPRECATION")
  private fun saveToPublicFolder(file: File, destination: String): WritableMap {
    val root = Environment.getExternalStoragePublicDirectory(
        if (destination == "music") Environment.DIRECTORY_MUSIC else Environment.DIRECTORY_DOWNLOADS,
    )
    val folder = File(root, CANTOR_FOLDER).apply { mkdirs() }
    val target = uniqueFile(folder, file.name)
    file.copyTo(target)
    val latch = CountDownLatch(1)
    var scanned: Uri? = null
    MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null) { _, uri ->
      scanned = uri
      latch.countDown()
    }
    latch.await(10, TimeUnit.SECONDS)
    val result = scanned?.let { where(it) } ?: Arguments.createMap().apply {
      putString("uri", Uri.fromFile(target).toString())
      putNull("mediaId")
    }
    result.putString("path", target.absolutePath)
    return result
  }

  /** A copy's URI, MediaStore id and path, for `export_copy`. */
  @Suppress("DEPRECATION")
  private fun where(uri: Uri): WritableMap {
    val result = Arguments.createMap()
    result.putString("uri", uri.toString())
    var id: Long? = runCatching { ContentUris.parseId(uri) }.getOrNull()?.takeIf { it >= 0 }
    var path: String? = null
    context.contentResolver.query(
        uri,
        arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATA),
        null,
        null,
        null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        id = cursor.getLong(0)
        path = cursor.getString(1)
      }
    }
    if (id == null) result.putNull("mediaId") else result.putDouble("mediaId", id!!.toDouble())
    if (path == null) result.putNull("path") else result.putString("path", path)
    return result
  }

  private fun staged(file: File): WritableMap = Arguments.createMap().apply {
    putString("path", file.absolutePath)
    putDouble("bytes", file.length().toDouble())
  }

  /** Only files this module staged may be shared or saved. */
  private fun stagedFile(path: String): File {
    val file = File(path).canonicalFile
    val root = exportsRoot.canonicalFile
    require(file.path.startsWith(root.path + File.separator) && file.isFile) {
      "That file was not prepared for export."
    }
    return file
  }

  private fun run(promise: Promise, operation: () -> Any?) {
    worker.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        promise.reject("E_CANTOR_EXPORT", error.message ?: "Export failed.", error)
      }
    }
  }
}

/** A display name: no separators, nothing hidden, not a directory's name. */
private fun requireFileName(name: String) {
  require(
      name.isNotBlank() && name.length <= 160 && !name.startsWith(".") &&
          name.none { it == '/' || it == '\\' || it == '\u0000' },
  ) { "File name is invalid." }
}

/** `Title.opus`, else `Title (1).opus`, as MediaStore names a clash. */
private fun uniqueFile(folder: File, name: String): File {
  val dot = name.lastIndexOf('.')
  val stem = if (dot > 0) name.substring(0, dot) else name
  val extension = if (dot > 0) name.substring(dot) else ""
  var candidate = File(folder, name)
  var n = 1
  while (candidate.exists()) {
    candidate = File(folder, "$stem ($n)$extension")
    n += 1
  }
  return candidate
}
