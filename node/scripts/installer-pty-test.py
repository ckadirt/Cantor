"""Exercise curl-style piped setup with a real controlling terminal."""
import errno
import os
import re
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
# Replies are fed in order, one per prompt. A prompt is anything ending in a
# bracketed default, which covers both `[Y/n]:` confirmations and free-text
# questions like `Backend to use [cuda12]:`.
replies = [reply.encode() + b'\n' for reply in sys.argv[2:]] or [b'Y\n', b'n\n', b'n\n']
PROMPT = re.compile(rb'\[[^\]\n]*\]: ')
pid, fd = pty.fork()
if pid == 0:
    os.execl('/bin/sh', 'sh', '-c', 'cat "$1" | sh', 'installer-test', installer)
output = b''
seen = 0
deadline = time.monotonic() + 20
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output += data
            while len(PROMPT.findall(output)) > seen and seen < len(replies):
                os.write(fd, replies[seen])
                seen += 1
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            assert os.waitstatus_to_exitcode(status) == 0, output.decode()
            pid = 0
            break
    else:
        raise AssertionError('Timed out: ' + output.decode())
    if pid:
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0, output.decode()
        pid = 0
    assert seen == len(replies), f'answered {seen} of {len(replies)}: ' + output.decode()
    assert b'Installed cantor' in output, output.decode()
    # The installer talks to the pty, not to this process's stdout. Replay the
    # transcript so a caller can assert on what an operator would have read.
    sys.stdout.write(output.decode(errors='replace'))
finally:
    os.close(fd)
    if pid:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
