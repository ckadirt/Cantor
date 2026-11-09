/*
 * Written for Cantor, in place of the one LAME's ./configure generates: the
 * library is compiled straight from its sources by CMake (see README.md).
 * Only what libmp3lame reads on Android (bionic, any ABI).
 */
#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STRING_H 1
#define HAVE_STDLIB_H 1
#define HAVE_LIMITS_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_UNISTD_H 1
#define HAVE_MEMORY_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
/* LAME's own speed-ups, both portable C. */
#define USE_FAST_LOG 1
#define TAKEHIRO_IEEE754_HACK 1
#define PACKAGE "lame"
#define VERSION "3.100"
/* configure normally provides this: a 32-bit IEEE float. */
typedef float ieee754_float32_t;
