import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, chownSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const binary = resolve('node/target/debug/cantor');
test('unprivileged detached lifecycle without systemd or XDG_RUNTIME_DIR', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'cantor-life-'));
  const home = join(root, 'home');
  const configHome = process.platform === 'darwin' ? join(home, 'Library/Application Support') : join(home, '.config');
  const config = join(configHome, 'cantor');
  const socket = join(config, 'control.sock');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'node.toml'), `name = "lifecycle-test"\nrelay_url = "ws://127.0.0.1:9"\nmodel_dir = "${home}/models"\nlibrary_dir = "${home}/library"\npairings = []\n`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(home, '.data') };
  delete env.XDG_RUNTIME_DIR;
  // Never touch the invoking root user's system socket or service.
  const identity = process.getuid() === 0 ? { uid: 65534, gid: 65534 } : {};
  chmodSync(root, 0o755);
  if (identity.uid) {
    for (const p of [home, configHome, config, join(config, 'node.toml')]) chownSync(p, identity.uid, identity.gid);
  }
  const run = (...args) => spawnSync(binary, args, { env, ...identity, encoding: 'utf8', timeout: 35000 });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `${args}: ${r.stderr}\n${r.stdout}`); return r.stdout; };
  try {
    ok('start');
    assert.match(ok('status'), /lifecycle-test/);
    env.XDG_RUNTIME_DIR = join(home, 'later-session-runtime');
    assert.match(ok('status'), /lifecycle-test/);
    assert.match(ok('start'), /already running/);
    const duplicate = run('run');
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /another node/);
    assert.match(ok('logs', '--lines', '20'), /control socket/);
    ok('restart');
    assert.match(ok('status'), /lifecycle-test/);
    ok('stop');
    assert.equal(existsSync(socket), false);
    assert.notEqual(run('status').status, 0);
    ok('stop');
    // Kernel lock file persists, but does not prevent a clean later start.
    assert.equal(existsSync(join(config, 'node.lock')), true);
    ok('start');
    ok('stop');
    const foreground = spawn(binary, ['run', '--control-socket', socket], { env, ...identity, stdio: 'ignore' });
    const exited = new Promise(resolve => foreground.once('exit', resolve));
    try {
      for (let i = 0; i < 100 && run('status').status !== 0; i++) await new Promise(r => setTimeout(r, 50));
      assert.match(ok('status'), /lifecycle-test/);
      const conflicting = run('run', '--config-dir', join(home, 'other-config'), '--control-socket', socket);
      assert.notEqual(conflicting.status, 0);
      assert.match(conflicting.stderr, /another node/);
    } finally {
      foreground.kill('SIGKILL');
      await exited;
    }
    assert.equal(existsSync(socket), true, 'crash leaves a stale socket');
    ok('start');
    assert.match(ok('status'), /lifecycle-test/);
    ok('stop');
    assert.match(readFileSync(join(config, 'node.log'), 'utf8'), /control socket/);
    const custom = join(home, 'custom config');
    renameSync(config, custom);
    mkdirSync(config);
    writeFileSync(join(config, 'installation.toml'), `directory = "${custom}"\n`);
    if (identity.uid) chownSync(config, identity.uid, identity.gid);
    ok('start');
    assert.match(ok('status'), /lifecycle-test/);
    assert.equal(existsSync(join(custom, 'control.sock')), true);
    ok('stop');
  } finally {
    run('stop');
    rmSync(root, { recursive: true, force: true });
  }
});
