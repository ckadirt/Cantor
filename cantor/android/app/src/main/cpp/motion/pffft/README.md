# pffft, double precision

Julien Pommier's PFFFT adapted to 64-bit floats by Dario Mambro
(https://github.com/unevens/pffft), FFTPACK licence (in each file's header).
Copied unchanged from the copy react-native-audio-api 0.13.3 ships inside
r8brain (`common/cpp/audioapi/dsp/r8brain/fft/`), so the app carries one
version of it.

Used by `../MotionAnalysis.cpp` for its spectra. Double precision, because the
reference analysis (docs/interfacealpha/reactive-player.html) is double and
the fixtures match it exactly. Compiled with hidden visibility (see
`src/main/jni/CMakeLists.txt`): audio-api's library exports the same
`pffftd_*` symbols, and neither library should bind to the other's.
