"""Exercise curl-style piped setup with a real controlling terminal."""
import errno
import os
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execl('/bin/sh', 'sh', '-c', 'cat "$1" | sh', 'installer-test', installer)
output = b''
replies = [b'Y\n', b'n\n', b'n\n']
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
            while output.count(b'[Y/n]:') > seen and seen < len(replies):
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
    assert seen == 3, output.decode()
    assert b'Installed cantor' in output, output.decode()
finally:
    os.close(fd)
    if pid:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
