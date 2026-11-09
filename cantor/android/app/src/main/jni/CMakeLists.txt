# The app's native library. React Native builds `libappmodules` from its
# default setup (`ReactNative-application.cmake`, included unchanged); this file
# exists only to add Cantor's own C++ to it. There is no *.cpp in this
# directory on purpose: one here would replace React Native's default OnLoad.
cmake_minimum_required(VERSION 3.13)
project(appmodules)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# FFmpeg as react-native-audio-api ships it (only MP4/AAC are decoded with it): its headers, and the shared
# libraries it already packages into the APK. Linking them here adds no copy;
# at run time the loader finds the ones audio-api put beside this library.
set(AUDIO_API_DIR ${PROJECT_ROOT_DIR}/../node_modules/react-native-audio-api)
set(FFMPEG_LIBS ${AUDIO_API_DIR}/android/src/main/jniLibs/${ANDROID_ABI})

set(CANTOR_CPP ${CMAKE_CURRENT_SOURCE_DIR}/../cpp)
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
        ${CANTOR_CPP}/AudioDecode.cpp
        ${CANTOR_CPP}/AudioReduction.cpp
        ${CANTOR_CPP}/motion/MotionAnalysis.cpp
        ${CANTOR_CPP}/motion/MotionTrackJni.cpp)
set_source_files_properties(${CANTOR_CPP}/motion/MotionAnalysis.cpp PROPERTIES COMPILE_OPTIONS "-O3")
# The motion analysis's FFT (cpp/motion/pffft/README.md): C, so a library of
# its own, out of reach of the app target's C++ flags. Hidden, because
# audio-api's library exports the same pffftd_* symbols; NEON on arm64,
# scalar on armeabi-v7a, SSE2 on x86.
add_library(cantor_pffft STATIC ${CANTOR_CPP}/motion/pffft/pffft_double.c)
target_compile_options(cantor_pffft PRIVATE -O3 -fvisibility=hidden -fPIC)
target_compile_definitions(cantor_pffft PRIVATE PFFFT_ENABLE_NEON)
target_link_libraries(${CMAKE_PROJECT_NAME} cantor_pffft)
# miniaudio's header for its declarations only; the implementation is
# audio-api's, looked up at run time (see AudioDecode.cpp).
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
        ${AUDIO_API_DIR}/common/cpp/audioapi/external/include_ffmpeg
        ${AUDIO_API_DIR}/common/cpp/audioapi/libs/miniaudio)
# The MP3 a song is shared or saved as (cpp/export/Mp3Encode.h), made by LAME
# (cpp/third_party/lame/README.md). LAME is LGPL, so it is a shared library of
# its own, libcantor_lame.so, rather than part of this one; its config.h is
# Cantor's, written in place of the one ./configure would make.
set(LAME_DIR ${CANTOR_CPP}/third_party/lame)
add_library(cantor_lame SHARED
        ${LAME_DIR}/libmp3lame/VbrTag.c
        ${LAME_DIR}/libmp3lame/bitstream.c
        ${LAME_DIR}/libmp3lame/encoder.c
        ${LAME_DIR}/libmp3lame/fft.c
        ${LAME_DIR}/libmp3lame/gain_analysis.c
        ${LAME_DIR}/libmp3lame/id3tag.c
        ${LAME_DIR}/libmp3lame/lame.c
        ${LAME_DIR}/libmp3lame/mpglib_interface.c
        ${LAME_DIR}/libmp3lame/newmdct.c
        ${LAME_DIR}/libmp3lame/presets.c
        ${LAME_DIR}/libmp3lame/psymodel.c
        ${LAME_DIR}/libmp3lame/quantize.c
        ${LAME_DIR}/libmp3lame/quantize_pvt.c
        ${LAME_DIR}/libmp3lame/reservoir.c
        ${LAME_DIR}/libmp3lame/set_get.c
        ${LAME_DIR}/libmp3lame/tables.c
        ${LAME_DIR}/libmp3lame/takehiro.c
        ${LAME_DIR}/libmp3lame/util.c
        ${LAME_DIR}/libmp3lame/vbrquantize.c
        ${LAME_DIR}/libmp3lame/version.c)
target_compile_definitions(cantor_lame PRIVATE HAVE_CONFIG_H)
target_include_directories(cantor_lame PRIVATE ${LAME_DIR} ${LAME_DIR}/libmp3lame)
target_include_directories(cantor_lame PUBLIC ${LAME_DIR}/include)
# LAME's own sources warn freely; they are left as they ship.
target_compile_options(cantor_lame PRIVATE -O2 -w)
target_link_libraries(cantor_lame m)
# 16 KB pages, as the app's own library is linked.
target_link_options(cantor_lame PRIVATE "-Wl,-z,max-page-size=16384")
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
        ${CANTOR_CPP}/export/Mp3Encode.cpp
        ${CANTOR_CPP}/export/Mp3EncodeJni.cpp)
target_link_libraries(${CMAKE_PROJECT_NAME} cantor_lame)

target_link_libraries(${CMAKE_PROJECT_NAME}
        ${FFMPEG_LIBS}/libavformat.so
        ${FFMPEG_LIBS}/libavcodec.so
        ${FFMPEG_LIBS}/libavutil.so
        ${FFMPEG_LIBS}/libswresample.so)
