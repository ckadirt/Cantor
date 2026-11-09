# Third-party symbol geometry

`src/motion/symbolArtwork.ts` contains normalized vector outlines derived from
the following open font projects. The application does not bundle either font
file; it stores only the selected glyph geometry required by the reusable
symbol primitives.

## STIX Math

- Used for: mathematical symbol silhouettes
- Copyright: 2001–2010 STI Pub Companies; 1998–2003 MicroPress, Inc.; 1990 Elsevier, Inc.
- Project: <https://www.stixfonts.org/>
- License: SIL Open Font License 1.1; see `licenses/OFL-1.1.txt`

## Noto Music

- Used for: musical notation silhouettes
- Copyright: 2010, 2012–2020 Google Inc.; 2015–2020 Google LLC
- Project: <https://github.com/notofonts/music>
- License: SIL Open Font License 1.1; see `licenses/OFL-1.1.txt`

# Third-party code

## LAME

- Used for: making the MP3 a song is shared or saved as
  (`android/app/src/main/cpp/export/Mp3Encode.cpp`)
- Version: 3.100, the `libmp3lame` library only, unmodified
- Copyright: the LAME project and its authors
- Project: <https://lame.sourceforge.io/>
- License: GNU Library General Public License, version 2; see
  `android/app/src/main/cpp/third_party/lame/COPYING`. It is built as its own
  shared library, `libcantor_lame.so`, so it can be replaced in the app.
