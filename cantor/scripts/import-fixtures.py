#!/usr/bin/env python3
"""Build the device-import fixtures: one 30 s tone per format, tagged as one
album, plus untagged loose files and a 3 s blip. See docs/import/log.md.

    python3 cantor/scripts/import-fixtures.py [out_dir]
    adb push <out_dir> /sdcard/Music/
    adb shell content call --uri content://media --method scan_volume --arg external_primary
"""
import os
import subprocess
import sys

D = sys.argv[1] if len(sys.argv) > 1 else '/tmp/cantor-import-test'
A = f'{D}/Test Artist/Fixture Album'
COVER_SRC = f'{D}/.cover.jpg'


def ff(args, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error'] + args + [out],
                       capture_output=True, text=True)
    print(os.path.relpath(out, D), 'OK' if r.returncode == 0 else r.stderr[-300:])


def src(rate=44100, seconds=30):
    return ['-f', 'lavfi', '-t', str(seconds), '-i', f'sine=f=220:sample_rate={rate}',
            '-f', 'lavfi', '-t', str(seconds), '-i', f'sine=f=330:sample_rate={rate}']


MIX = ['-filter_complex', '[0][1]amerge=inputs=2,volume=0.3[a]', '-map', '[a]']
COVER = ['-i', COVER_SRC]
PIC = ['-map', '2', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic']


def tag(title, n):
    pairs = {'title': title, 'artist': 'Test Artist', 'album': 'Fixture Album',
             'album_artist': 'Test Artist', 'track': f'{n}/10', 'disc': '1/1',
             'date': '2019', 'genre': 'Ambient'}
    return [x for k, v in pairs.items() for x in ('-metadata', f'{k}={v}')]


os.makedirs(A, exist_ok=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                'gradients=s=600x600:c0=0x202020:c1=0xf0e8d8:x0=0:y0=0:x1=600:y1=600,'
                'drawbox=x=150:y=150:w=300:h=300:color=black@0.9:t=fill',
                '-frames:v', '1', '-update', '1', COVER_SRC], check=True)
subprocess.run(['cp', COVER_SRC, f'{A}/cover.jpg'], check=True)

album = [
    (src() + COVER + MIX + PIC + ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3'] + tag('Tone MP3', 1), '01 - Tone MP3.mp3'),
    (src() + COVER + MIX + PIC + ['-c:a', 'flac'] + tag('Tone FLAC 16-44', 2), '02 - Tone FLAC 16-44.flac'),
    (src(96000) + COVER + MIX + PIC + ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] + tag('Tone FLAC 24-96', 3), '03 - Tone FLAC 24-96.flac'),
    (src() + COVER + MIX + PIC + ['-c:a', 'aac', '-b:a', '256k'] + tag('Tone AAC', 4), '04 - Tone AAC.m4a'),
    (src() + COVER + MIX + PIC + ['-c:a', 'alac'] + tag('Tone ALAC', 5), '05 - Tone ALAC.m4a'),
    (src() + MIX + ['-c:a', 'libvorbis', '-q:a', '5'] + tag('Tone Vorbis', 6), '06 - Tone Vorbis.ogg'),
    (src() + MIX + ['-c:a', 'libopus', '-b:a', '128k'] + tag('Tone Opus', 7), '07 - Tone Opus.opus'),
    (src() + MIX + ['-c:a', 'pcm_s16le'] + tag('Tone WAV', 8), '08 - Tone WAV.wav'),
    (src() + MIX + ['-c:a', 'pcm_s16be', '-write_id3v2', '1'] + tag('Tone AIFF', 9), '09 - Tone AIFF.aiff'),
]
for args, name in album:
    ff(args, f'{A}/{name}')

ff(src() + MIX + ['-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1'], f'{D}/loose/07 - Untagged Tone.mp3')
ff(src() + MIX + ['-c:a', 'flac', '-map_metadata', '-1'], f'{D}/loose/Some Artist - Name Only.flac')
ff(['-f', 'lavfi', '-t', '3', '-i', 'sine=f=880', '-c:a', 'libmp3lame'], f'{D}/short/blip.mp3')
os.remove(COVER_SRC)
