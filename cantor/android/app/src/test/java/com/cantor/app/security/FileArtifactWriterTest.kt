package com.cantor.app.security

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class FileArtifactWriterTest {
  private val root: File = Files.createTempDirectory("exports").toFile()

  @Test
  fun writesInOrderAndResumesWhereTheFileEnds() {
    val path = File(root, "key/.master.part").path
    FileArtifactWriter(path, root).apply {
      write(0, byteArrayOf(1, 2, 3, 4), 0, 4)
      write(4, byteArrayOf(9, 5, 6), 1, 2)
      close()
    }
    // A second transfer picks up at the end.
    FileArtifactWriter(path, root).apply {
      write(6, byteArrayOf(7), 0, 1)
      close()
    }
    assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7), File(path).readBytes())
  }

  @Test
  fun refusesAGapOrAnOverlap() {
    val writer = FileArtifactWriter(File(root, "gap.part").path, root)
    writer.write(0, byteArrayOf(1, 2), 0, 2)
    assertThrows(IllegalArgumentException::class.java) { writer.write(5, byteArrayOf(1), 0, 1) }
    assertThrows(IllegalArgumentException::class.java) { writer.write(1, byteArrayOf(1), 0, 1) }
    writer.close()
  }

  @Test
  fun refusesAPathOutsideTheExportCache() {
    assertThrows(IllegalArgumentException::class.java) {
      FileArtifactWriter(File(root, "../outside.part").path, root)
    }
    assertThrows(IllegalArgumentException::class.java) {
      FileArtifactWriter("/data/data/elsewhere/file", root)
    }
  }
}
