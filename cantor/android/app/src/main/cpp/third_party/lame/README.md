# LAME 3.100, the MP3 encoder

`libmp3lame` from LAME 3.100 (<https://lame.sourceforge.io/>), used to make the
MP3 a song is shared or saved as (`../../export/Mp3Encode.cpp`). Licensed under
the GNU Library General Public License, version 2 (`COPYING`).

- **What is here:** `libmp3lame/*.c` and `*.h`, `libmp3lame/vector/lame_intrin.h`
  (declarations only; `fft.c` includes it unconditionally), and `include/lame.h`, copied
  unchanged from `lame-3.100.tar.gz` (SHA-256
  `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`). The
  frontend, the decoder (mpglib), the x86 assembly and the SSE path are left
  out.
- **What is Cantor's:** `config.h`, written by hand in place of the one LAME's
  `./configure` makes. CMake compiles the sources directly.
- **Built as its own shared library**, `libcantor_lame.so`, so it stays a
  separate, replaceable part of the app as the LGPL asks
  (`src/main/jni/CMakeLists.txt`).

To update: replace the copied files with a newer release's, keep `config.h`,
and check the source list in the CMake file against `libmp3lame/Makefile.am`.
