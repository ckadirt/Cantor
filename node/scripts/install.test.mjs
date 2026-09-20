import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const reachable of [false, true]) {
  test(`unprivileged installer with ${reachable ? 'reachable' : 'missing'} user manager`, () => {
    const root = mkdtempSync(join(tmpdir(), 'cantor-install-'));
    try {
      const home = join(root, "studio's home");
      const bin = join(root, 'commands');
      mkdirSync(home);
      mkdirSync(bin);
      const calls = join(root, 'calls');
      const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      command('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac');
      command('id', 'case "$1" in -u) echo 1000;; -un) echo studio;; esac');
      command('systemctl', `printf '%s\\n' "$*" >> "$CALLS"\nexit ${reachable ? 0 : 1}`);
      command('loginctl', 'printf "linger\\n" >> "$CALLS"');
      command('cantor-source', 'printf "%s\\n" "$@"');
      const result = spawnSync('sh', [resolve('node/install.sh')], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
          XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
          CANTOR_INSTALL_DIR: join(home, '.local/bin'), CANTOR_NODE_BINARY: join(bin, 'cantor-source'),
          CANTOR_CONFIG_DIR: join(home, '.config/cantor'),
          CANTOR_SERVICE_PATH: join(home, 'cantor.service'),
          CANTOR_MODEL_DIR: join(home, 'models'), CANTOR_LIBRARY_DIR: join(home, 'library'),
          CANTOR_SKIP_LINGER: '0', CANTOR_SKIP_SYSTEMD_RELOAD: '0', CALLS: calls },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(home, 'cantor.service')), reachable);
      const history = readFileSync(calls, 'utf8');
      assert.match(history, /--user show --property=Version/);
      if (reachable) {
        assert.match(history, /--user daemon-reload/);
        assert.match(history, /linger/);
      } else {
        assert.doesNotMatch(history, /daemon-reload|linger|enable/);
        assert.doesNotMatch(result.stdout, /systemctl --user enable/);
        assert.match(result.stdout, / start/);
        assert.doesNotMatch(result.stdout, /--control-socket/);
        assert.match(result.stdout, /Background mode: detached/);
        const profile = readFileSync(join(home, '.profile'), 'utf8');
        const parsed = spawnSync('sh', ['-c', `${profile}\nprintf '%s' "$PATH"`], { encoding: 'utf8' });
        assert.equal(parsed.status, 0, parsed.stderr);
        assert.ok(parsed.stdout.startsWith(`${home}/.local/bin:`));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('macOS installer writes escaped launch agent and native paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'cantor-mac-'));
  try {
    const home = join(root, 'Mac & Home');
    const bin = join(root, 'bin');
    mkdirSync(home); mkdirSync(bin);
    const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    command('uname', 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac');
    command('id', 'echo 501');
    command('source', 'exit 0');
    const result = spawnSync('sh', [resolve('node/install.sh')], { encoding: 'utf8', env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CANTOR_NON_INTERACTIVE: '1',
      CANTOR_NODE_BINARY: join(bin, 'source'),
    }});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(home, '.local/bin/cantor')));
    assert.ok(existsSync(join(home, 'Library/Application Support/cantor/node.toml')));
    const plist = readFileSync(join(home, 'Library/LaunchAgents/xyz.ckadirt.cantor.plist'), 'utf8');
    assert.match(plist, /Mac &amp; Home/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.doesNotMatch(result.stdout, /systemctl|detached process/);
    const parsed = spawnSync('python3', ['-c', 'import plistlib,sys; p=plistlib.loads(sys.stdin.buffer.read()); assert p["ProgramArguments"][1] == "run"'], { input: plist, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('piped install prompts on the terminal and continues after detached start', () => {
  const root = mkdtempSync(join(tmpdir(), 'cantor-pipe-'));
  try {
    const home = join(root, 'home'); const bin = join(root, 'bin');
    mkdirSync(home); mkdirSync(bin);
    const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    command('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac');
    command('id', 'echo 1000');
    command('systemctl', 'exit 1');
    command('source', 'printf "%s\\n" "$*" >> "$CALLS"\nexit 0');
    const calls = join(root, 'calls');
    const result = spawnSync('python3', [resolve('node/scripts/installer-pty-test.py'), resolve('node/install.sh')], { encoding: 'utf8', timeout: 25000, env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CALLS: calls,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.data'),
      CANTOR_NODE_BINARY: join(bin, 'source'), CANTOR_NODE_NAME: 'pipe-test',
      CANTOR_RELAY_URL: 'wss://cantor.ckadirt.xyz', CANTOR_NON_INTERACTIVE: '0',
      CANTOR_MODEL_DIR: join(home, 'models'), CANTOR_LIBRARY_DIR: join(home, 'library'),
    }});
    assert.equal(result.status, 0, result.stderr);
    const history = readFileSync(calls, 'utf8');
    assert.match(history, /^start$/m);
    assert.match(history, /^status$/m);
    assert.match(history, /^list --all$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('setup detects accelerators and selects the operator\'s choice', () => {
  const root = mkdtempSync(join(tmpdir(), 'cantor-backend-'));
  try {
    const home = join(root, 'home'); const bin = join(root, 'bin');
    mkdirSync(home); mkdirSync(bin);
    const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    command('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac');
    command('id', 'echo 1000');
    command('systemctl', 'exit 1');
    // Only a bare `backends` reports detection; `--use` just switches.
    command('source', `printf "%s\\n" "$*" >> "$CALLS"
case "$*" in
  backends)
    printf 'architecture  x86_64\\n\\nDetected, in preference order:\\n'
    printf '  cuda12   nvidia-smi reports a device \u00b7 NVIDIA H100\\n'
    printf '  cpu      always available\\n'
    printf '\\nSelected cuda12\\n  engine    acestep 1.5\\n'
    ;;
esac
exit 0`);
    const calls = join(root, 'calls');
    const result = spawnSync('python3', [resolve('node/scripts/installer-pty-test.py'), resolve('node/install.sh'),
      'Y', 'n', 'Y', 'cpu'], { encoding: 'utf8', timeout: 25000, env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CALLS: calls,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.data'),
      CANTOR_NODE_BINARY: join(bin, 'source'), CANTOR_NODE_NAME: 'backend-test',
      CANTOR_RELAY_URL: 'wss://cantor.ckadirt.xyz', CANTOR_NON_INTERACTIVE: '0',
      CANTOR_MODEL_DIR: join(home, 'models'), CANTOR_LIBRARY_DIR: join(home, 'library'),
    }});
    assert.equal(result.status, 0, result.stderr);
    const history = readFileSync(calls, 'utf8');
    // No selector typed: the node's chooser asks which variant.
    assert.match(history, /^pull$/m);
    // Detection first, then the operator's pick -- not the detected default.
    assert.match(history, /^backends$/m);
    assert.match(history, /^backends --use cpu$/m);
    // PATH is only configured for future shells, so say so where it is read.
    assert.match(result.stdout, /Open another terminal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [arch, target] of [['arm64', 'aarch64-apple-darwin'], ['x86_64', 'x86_64-apple-darwin']]) {
  test(`macOS download selects and verifies ${target}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'cantor-download-'));
    try {
      const home = join(root, 'home'); const bin = join(root, 'bin');
      mkdirSync(home); mkdirSync(bin);
      const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      command('uname', `case "$1" in -s) echo Darwin;; -m) echo ${arch};; esac`);
      command('id', 'echo 501');
      const source = '#!/bin/sh\nexit 0\n';
      writeFileSync(join(root, 'source'), source);
      command('curl', `while [ "$#" -gt 0 ]; do
        case "$1" in https://*) url=$1;; -o) shift; out=$1;; esac
        shift
      done
      printf '%s\\n' "$url" >> "$CALLS"
      case "$url" in *.sha256) printf '%s  cantor\\n' "$DIGEST" > "$out";; *) cp "$SOURCE" "$out";; esac`);
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
        CANTOR_NON_INTERACTIVE: '1', SOURCE: join(root, 'source'), CALLS: join(root, 'calls'),
        DIGEST: createHash('sha256').update(source).digest('hex') };
      delete env.CANTOR_NODE_BINARY;
      delete env.CANTOR_NODE_URL;
      delete env.CANTOR_NODE_SHA256;
      const result = spawnSync('sh', [resolve('node/install.sh')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const urls = readFileSync(env.CALLS, 'utf8');
      assert.match(urls, new RegExp(`/${target.replace(/^/, 'cantor-')}\\n`));
      assert.match(urls, /\.sha256/);
      assert.doesNotMatch(urls, /linux/);
      assert.equal(readFileSync(join(home, '.local/bin/cantor'), 'utf8'), source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
