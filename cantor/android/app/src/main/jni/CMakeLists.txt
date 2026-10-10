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
target_link_libraries(${CMAKE_PROJECT_NAME}
        ${FFMPEG_LIBS}/libavformat.so
        ${FFMPEG_LIBS}/libavcodec.so
        ${FFMPEG_LIBS}/libavutil.so
        ${FFMPEG_LIBS}/libswresample.so)
