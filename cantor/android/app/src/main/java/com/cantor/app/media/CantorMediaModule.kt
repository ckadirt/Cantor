package com.cantor.app.media

import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

private const val MODULE_NAME = "CantorMedia"

/** Bytes of a file's head hashed for its fingerprint (docs/import/plan.md). */
private const val HEAD_BYTES = 64 * 1024

/** The longest side of a saved album thumbnail, in pixels. */
private const val ARTWORK_PX = 256

private const val ARTWORK_QUALITY = 85

private val ARTWORK_NAME = Regex("^[a-z0-9_-]{1,64}$")

/** The most cells a side of an artwork's brightness grid may have. */
private const val LUMA_MAX_CELLS = 96

/**
 * The phone's music, as Android indexes it — read only.
 *
 * Device import (docs/import/) reads MediaStore for what is on the phone, opens
 * a file by its path to fingerprint it, and asks MediaStore for album art. It
 * never writes, moves or deletes a user's file. Decisions — what a row means,
 * which title wins, what an album is — are the JS resolver's; this module
 * passes raw values through.
 *
 * Everything runs on its own thread: a first scan inspects hundreds of files,
 * and the module queue must stay free for everything else.
 */
class CantorMediaModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
  private val worker = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "CantorMedia")
  }

  override fun getName(): String = MODULE_NAME

  /**
   * MediaStore's generation for the primary volume: equal to the last scan's
   * means nothing was added, changed or removed since. −1 before Android 11,
   * where there is none and every scan is a full one.
   */
  @ReactMethod
  fun generation(promise: Promise) {
    run(promise) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        MediaStore.getGeneration(context, MediaStore.VOLUME_EXTERNAL_PRIMARY).toDouble()
      } else {
        -1.0
      }
    }
  }

  /**
   * Every music row at least `minDurationMs` long, metadata only.
   *
   * Always the whole list: it is also how a scan learns which songs went
   * missing, which a query for changed rows cannot say. `IS_MUSIC = 1` leaves
   * out ringtones, alarms, notifications and recordings; the duration floor
   * leaves out the short blips `IS_MUSIC` lets through (I0).
   */
  @ReactMethod
  fun list(minDurationMs: Double, promise: Promise) {
    run(promise) {
      val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
      val columns = mutableListOf(
          MediaStore.Audio.Media._ID,
          MediaStore.Audio.Media.DATA,
          MediaStore.Audio.Media.TITLE,
          MediaStore.Audio.Media.ARTIST,
          MediaStore.Audio.Media.ALBUM,
          MediaStore.Audio.Media.TRACK,
          MediaStore.Audio.Media.YEAR,
          MediaStore.Audio.Media.DURATION,
          MediaStore.Audio.Media.MIME_TYPE,
          MediaStore.Audio.Media.SIZE,
          MediaStore.Audio.Media.DATE_ADDED,
      )
      if (modern) {
        columns += listOf(
            MediaStore.Audio.Media.ALBUM_ARTIST,
            MediaStore.Audio.Media.DISC_NUMBER,
            MediaStore.Audio.Media.GENRE,
            MediaStore.Audio.Media.GENERATION_MODIFIED,
        )
      }
      val rows = Arguments.createArray()
      context.contentResolver.query(
          MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
          columns.toTypedArray(),
          "${MediaStore.Audio.Media.IS_MUSIC} = 1 AND ${MediaStore.Audio.Media.DURATION} >= ?",
          arrayOf(minDurationMs.toLong().toString()),
          "${MediaStore.Audio.Media._ID} ASC",
      )?.use { cursor ->
        fun index(column: String) = cursor.getColumnIndexOrThrow(column)
        val id = index(MediaStore.Audio.Media._ID)
        val data = index(MediaStore.Audio.Media.DATA)
        val title = index(MediaStore.Audio.Media.TITLE)
        val artist = index(MediaStore.Audio.Media.ARTIST)
        val album = index(MediaStore.Audio.Media.ALBUM)
        val track = index(MediaStore.Audio.Media.TRACK)
        val year = index(MediaStore.Audio.Media.YEAR)
        val duration = index(MediaStore.Audio.Media.DURATION)
        val mime = index(MediaStore.Audio.Media.MIME_TYPE)
        val size = index(MediaStore.Audio.Media.SIZE)
        val added = index(MediaStore.Audio.Media.DATE_ADDED)
        val albumArtist = if (modern) index(MediaStore.Audio.Media.ALBUM_ARTIST) else -1
        val disc = if (modern) index(MediaStore.Audio.Media.DISC_NUMBER) else -1
        val genre = if (modern) index(MediaStore.Audio.Media.GENRE) else -1
        val generation = if (modern) index(MediaStore.Audio.Media.GENERATION_MODIFIED) else -1
        while (cursor.moveToNext()) {
          val path = cursor.getString(data) ?: continue
          rows.pushMap(
              Arguments.createMap().apply {
                putDouble("mediaId", cursor.getLong(id).toDouble())
                putString("path", path)
                putNullableString("title", cursor.getString(title))
                putNullableString("artist", cursor.getString(artist))
                putNullableString("album", cursor.getString(album))
                putNullableString("albumArtist", if (albumArtist >= 0) cursor.getString(albumArtist) else null)
                putNullableNumber("track", if (cursor.isNull(track)) null else cursor.getLong(track))
                putNullableString("disc", if (disc >= 0) cursor.getString(disc) else null)
                putNullableNumber("year", if (cursor.isNull(year)) null else cursor.getLong(year))
                putNullableString("genre", if (genre >= 0) cursor.getString(genre) else null)
                putDouble("durationMs", cursor.getLong(duration).toDouble())
                putNullableString("mime", cursor.getString(mime))
                putDouble("size", cursor.getLong(size).toDouble())
                // MediaStore keeps seconds.
                putDouble("addedAtMs", cursor.getLong(added) * 1000.0)
                putNullableNumber("generation", if (generation >= 0) cursor.getLong(generation) else null)
              },
          )
        }
      }
      rows
    }
  }

  /**
   * A new or changed file's fingerprint and the tags `MediaMetadataRetriever`
   * reads from it.
   *
   * The retriever is the second reader (docs/import/log.md, I0): its album is
   * null when the file has no album tag, where MediaStore substitutes the
   * folder's name, and its date fills the year MediaStore drops for FLAC, Ogg
   * and Opus. It reads neither WAV nor AIFF tags.
   */
  @ReactMethod
  fun inspect(path: String, promise: Promise) {
    run(promise) {
      val file = File(path)
      val size = file.length()
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(file).use { stream ->
        val buffer = ByteArray(HEAD_BYTES)
        var filled = 0
        while (filled < HEAD_BYTES) {
          val read = stream.read(buffer, filled, HEAD_BYTES - filled)
          if (read < 0) break
          filled += read
        }
        digest.update(buffer, 0, filled)
      }
      val result = Arguments.createMap()
      result.putDouble("size", size.toDouble())
      result.putString("headSha256", digest.digest().joinToString("") { "%02x".format(it) })
      val tags = Arguments.createMap()
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(path)
        for ((key, code) in RETRIEVER_KEYS) {
          tags.putNullableString(key, retriever.extractMetadata(code)?.takeIf { it.isNotBlank() })
        }
      } catch (_: RuntimeException) {
        // A file the retriever cannot parse still has a fingerprint; its tags
        // come from MediaStore alone.
      } finally {
        retriever.release()
      }
      result.putMap("tags", tags)
      result
    }
  }

  /**
   * Save an album's art, at most `ARTWORK_PX` on its longest side, as
   * `files/artwork/<name>.jpg`; resolves with the file name, or null when the
   * song has none.
   *
   * `loadThumbnail` returns the embedded picture or, failing that, the
   * folder's `cover.jpg`/`folder.jpg` — which the app cannot open itself with
   * audio permission — and ignores the size it is asked for (I0), hence the
   * downscale. Files, not cache: the album row points at this file, and the
   * system must not clear it behind the database's back.
   */
  @ReactMethod
  fun albumArt(mediaId: Double, name: String, promise: Promise) {
    run(promise) {
      require(ARTWORK_NAME.matches(name)) { "Invalid artwork name." }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@run null
      val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId.toLong())
      val source = try {
        context.contentResolver.loadThumbnail(uri, Size(ARTWORK_PX, ARTWORK_PX), null)
      } catch (_: FileNotFoundException) {
        return@run null
      }
      val scale = ARTWORK_PX.toFloat() / max(source.width, source.height)
      val bitmap =
          if (scale < 1f) {
            Bitmap.createScaledBitmap(
                source,
                (source.width * scale).roundToInt().coerceAtLeast(1),
                (source.height * scale).roundToInt().coerceAtLeast(1),
                true,
            )
          } else {
            source
          }
      val directory = File(context.filesDir, "artwork").apply { mkdirs() }
      val target = File(directory, "$name.jpg")
      val partial = File(directory, "$name.jpg.partial")
      partial.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, ARTWORK_QUALITY, it) }
      if (!partial.renameTo(target)) throw IllegalStateException("Could not save artwork.")
      "$name.jpg"
    }
  }

  /**
   * Delete every saved album art file whose name is not in `keep`; resolves
   * with the names removed. Only Cantor's own `files/artwork/` is touched.
   * Called after a scan commits, so a file an album row names is never
   * removed, and one no row names does not linger.
   */
  @ReactMethod
  fun pruneArtwork(keep: ReadableArray, promise: Promise) {
    run(promise) {
      val kept = (0 until keep.size()).mapNotNull { keep.getString(it) }.toSet()
      val removed = Arguments.createArray()
      File(context.filesDir, "artwork").listFiles()?.forEach { file ->
        if (file.isFile && file.name !in kept && file.delete()) removed.pushString(file.name)
      }
      removed
    }
  }

  /**
   * A saved album thumbnail as a `cells × cells` grid of brightness, 0 black
   * to 1 white, row by row: the middle square of the picture, averaged down.
   * Null when the file is gone. Reads only Cantor's own `files/artwork/`.
   *
   * What the cover lens draws from (docs/import/ I6c). Nothing is kept: the
   * grid is a few kilobytes and a few milliseconds, so it is made again
   * whenever it is asked for.
   */
  @ReactMethod
  fun artworkLuma(file: String, cells: Double, promise: Promise) {
    run(promise) {
      require(file.endsWith(".jpg") && ARTWORK_NAME.matches(file.removeSuffix(".jpg"))) {
        "Invalid artwork name."
      }
      val side = cells.toInt()
      require(side in 1..LUMA_MAX_CELLS) { "Invalid cell count." }
      val source = File(File(context.filesDir, "artwork"), file)
      val decoded = BitmapFactory.decodeFile(source.path) ?: return@run null
      lumaGrid(decoded, side)
    }
  }

  /**
   * A song's MediaStore thumbnail as a `cells × cells` brightness grid, the
   * same reduction as `artworkLuma`; null when it has none.
   *
   * For the picture shown while an album is being read, before its art is
   * saved (docs/import/flow-plan.md, I7b). Display only: nothing is written.
   */
  @ReactMethod
  fun thumbnailLuma(mediaId: Double, cells: Double, promise: Promise) {
    run(promise) {
      val side = cells.toInt()
      require(side in 1..LUMA_MAX_CELLS) { "Invalid cell count." }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@run null
      val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId.toLong())
      val thumbnail = try {
        context.contentResolver.loadThumbnail(uri, Size(ARTWORK_PX, ARTWORK_PX), null)
      } catch (_: FileNotFoundException) {
        return@run null
      }
      lumaGrid(thumbnail, side)
    }
  }

  /** The middle square of a picture, averaged down to `side × side` brightness. */
  private fun lumaGrid(decoded: Bitmap, side: Int): WritableArray {
    val square = minOf(decoded.width, decoded.height)
    val cropped = Bitmap.createBitmap(
        decoded,
        (decoded.width - square) / 2,
        (decoded.height - square) / 2,
        square,
        square,
    )
    val grid = Bitmap.createScaledBitmap(cropped, side, side, true)
    val pixels = IntArray(side * side)
    grid.getPixels(pixels, 0, side, 0, 0, side, side)
    val luma = Arguments.createArray()
    for (pixel in pixels) {
      val r = (pixel shr 16) and 0xff
      val g = (pixel shr 8) and 0xff
      val b = pixel and 0xff
      // Rec. 709 weights on the stored values: the grid only has to order
      // light against dark, not measure it.
      luma.pushDouble((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0)
    }
    return luma
  }

  private fun run(promise: Promise, operation: () -> Any?) {
    worker.execute {
      try {
        promise.resolve(operation())
      } catch (error: Throwable) {
        promise.reject("E_CANTOR_MEDIA", error.message ?: "Media operation failed.", error)
      }
    }
  }
}

private val RETRIEVER_KEYS = listOf(
    "title" to MediaMetadataRetriever.METADATA_KEY_TITLE,
    "artist" to MediaMetadataRetriever.METADATA_KEY_ARTIST,
    "album" to MediaMetadataRetriever.METADATA_KEY_ALBUM,
    "albumArtist" to MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST,
    "track" to MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER,
    "disc" to MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER,
    "year" to MediaMetadataRetriever.METADATA_KEY_YEAR,
    "date" to MediaMetadataRetriever.METADATA_KEY_DATE,
    "genre" to MediaMetadataRetriever.METADATA_KEY_GENRE,
)

private fun WritableMap.putNullableString(key: String, value: String?) {
  if (value == null) putNull(key) else putString(key, value)
}

private fun WritableMap.putNullableNumber(key: String, value: Long?) {
  if (value == null) putNull(key) else putDouble(key, value.toDouble())
}
