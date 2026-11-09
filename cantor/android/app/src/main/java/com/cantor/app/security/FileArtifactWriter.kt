package com.cantor.app.security

import java.io.File
import java.io.RandomAccessFile

/**
 * A download written to one file instead of the audio store: how the node's
 * master reaches the export cache to be saved as WAV
 * (internal/docs/plans/take-it-plan.md, E3). Only a file under [root] may be
 * written, and only in order, so a resumed transfer continues exactly where
 * the file ends.
 */
internal class FileArtifactWriter(path: String, root: File) : ArtifactWriter {
  private val file: File = File(path).canonicalFile

  init {
    val base = root.canonicalFile
    require(file.path.startsWith(base.path + File.separator)) {
      "A download may only be written inside the export cache."
    }
    file.parentFile?.mkdirs()
  }

  private var output: RandomAccessFile? = null

  @Synchronized
  override fun write(offset: Long, data: ByteArray, from: Int, length: Int) {
    val target = output ?: RandomAccessFile(file, "rw").also { output = it }
    require(target.length() == offset) { "Download offset does not continue the file." }
    target.seek(offset)
    target.write(data, from, length)
  }

  @Synchronized
  override fun close() {
    output?.let {
      it.fd.sync()
      it.close()
    }
    output = null
  }
}
