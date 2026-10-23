#!/usr/bin/env node
/**
 * Publish Cantor for Android in one command, on the machine that holds the
 * release key (it never leaves it):
 *
 *   npm run release:apk -- patch --notes "Songs you cancel no longer come back"
 *   npm run release:apk -- 0.2.0 --notes "…"
 *   npm run release:apk -- patch --notes "…" --dry-run   # build and verify only
 *
 * 1. Preflight: on main, clean, level with origin; gh signed in; the keystore
 *    is Cantor's (by its certificate's SHA-256); the tag is free; the notes are
 *    one short line in the site's copy rules.
 * 2. Bump versionCode (+1) and versionName in android/app/build.gradle.
 * 3. Build the arm64 release APK.
 * 4. Verify the APK: Cantor's certificate, com.cantor.app, the new versionCode.
 * 5. Commit the bump with the site's APP record (docs/src/site.ts), tag it
 *    app-vX.Y.Z, publish the GitHub release (not marked latest: `cantor
 *    upgrade` reads GitHub's latest release for the node), then push main,
 *    which redeploys cantorfm.com: /download and /app/latest.json move to it,
 *    and every installed Cantor offers the update.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cantor's release certificate (memory `app-release-signing`, the 0.1.0 release notes). */
const CANTOR_CERT_SHA256 = '287cb2af5d2a18103942db80b3a9f1f16835b235dda98828b86e58c44d05d810';
const PACKAGE = 'com.cantor.app';
const NOTES_MAX = 90;

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const repo = resolve(app, '..');
const gradleFile = join(app, 'android', 'app', 'build.gradle');
const siteFile = join(repo, 'docs', 'src', 'site.ts');
const builtApk = join(app, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

// ---- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const notesAt = args.indexOf('--notes');
const notes = notesAt >= 0 ? (args[notesAt + 1] ?? '').trim() : '';
const bump = args.find((a, i) => !a.startsWith('--') && i !== notesAt + 1);

function fail(message) {
  console.error(`\nrelease-apk: ${message}`);
  process.exit(1);
}
function step(message) {
  console.log(`\n▸ ${message}`);
}
function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
function sh(cmd, cmdArgs, options = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...options });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
}

if (!bump) fail('say which version: patch, minor, major or X.Y.Z (and --notes "…").');
if (!notes) fail('--notes "…" is required: the one line installed apps show under Update.');
if (notes.length > NOTES_MAX) fail(`the notes are ${notes.length} characters; keep them under ${NOTES_MAX}.`);
if (/[—–]/.test(notes)) fail('the notes have a long dash; the site\'s copy rules use colons, commas and full stops.');
if (/["\\\n]/.test(notes)) fail('the notes cannot hold quotes, backslashes or line breaks.');

// ---- 1. preflight ------------------------------------------------------------

step('Preflight');
const branch = run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`on ${branch}; publish from main.`);
if (run('git', ['-C', repo, 'status', '--porcelain'])) fail('the working tree is not clean; commit or stash first.');
run('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main']);
if (run('git', ['-C', repo, 'rev-parse', 'HEAD']) !== run('git', ['-C', repo, 'rev-parse', 'origin/main'])) {
  fail('main is not level with origin/main; pull or push first.');
}
if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status !== 0) fail('gh is not signed in (gh auth login).');

const keystore = readKeystoreProperties();
const keyFingerprint = keystoreFingerprint(keystore);
if (keyFingerprint !== CANTOR_CERT_SHA256) {
  fail(`the keystore's certificate is ${keyFingerprint}, not Cantor's. Publishing with another key would make every installed Cantor refuse the update.`);
}
console.log('  keystore is Cantor\'s release key');

const gradle = readFileSync(gradleFile, 'utf8');
const oldCode = Number(/versionCode (\d+)/.exec(gradle)?.[1]);
const oldName = /versionName "([\d.]+)"/.exec(gradle)?.[1];
if (!oldCode || !oldName) fail('could not read versionCode/versionName from build.gradle.');
const versionName = nextVersion(oldName, bump);
const versionCode = oldCode + 1;
const tag = `app-v${versionName}`;
if (spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore', cwd: repo }).status === 0) fail(`${tag} is already released.`);
if (run('git', ['-C', repo, 'tag', '--list', tag])) fail(`the tag ${tag} already exists locally.`);
console.log(`  ${oldName} (${oldCode}) → ${versionName} (${versionCode}), tag ${tag}`);

// ---- 2. bump -----------------------------------------------------------------

step('Bump the version');
writeFileSync(
  gradleFile,
  gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[\d.]+"/, `versionName "${versionName}"`),
);

// ---- 3. build ----------------------------------------------------------------

step('Build the arm64 release APK');
sh('./gradlew', ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a', '--console=plain'], { cwd: join(app, 'android') });
if (!existsSync(builtApk)) fail(`no APK at ${builtApk}`);

// ---- 4. verify ---------------------------------------------------------------

step('Verify the APK');
const tools = buildTools();
const certs = run(join(tools, 'apksigner'), ['verify', '--print-certs', builtApk]);
const signer = /certificate SHA-256 digest: ([0-9a-f]+)/.exec(certs)?.[1];
if (signer !== CANTOR_CERT_SHA256) fail(`the APK is signed by ${signer}, not Cantor's key.`);
const badging = run(join(tools, 'aapt2'), ['dump', 'badging', builtApk]);
const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
if (!pkg || pkg[1] !== PACKAGE || Number(pkg[2]) !== versionCode || pkg[3] !== versionName) {
  fail(`the APK is ${pkg?.[1]} ${pkg?.[3]} (${pkg?.[2]}), not ${PACKAGE} ${versionName} (${versionCode}).`);
}
const outDir = join(app, 'android', 'app', 'build', 'published');
mkdirSync(outDir, { recursive: true });
const apkName = `cantor-${versionName}-arm64.apk`;
const apk = join(outDir, apkName);
copyFileSync(builtApk, apk);
const sha256 = createHash('sha256').update(readFileSync(apk)).digest('hex');
const bytes = statSync(apk).size;
writeFileSync(`${apk}.sha256`, `${sha256}  ${apkName}\n`);
console.log(`  ${PACKAGE} ${versionName} (${versionCode}), Cantor's key, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`  ${apk}`);

if (dryRun) {
  // Put build.gradle back: a dry run publishes nothing and leaves no change.
  writeFileSync(gradleFile, gradle);
  console.log('\nDry run: built and verified, nothing published; build.gradle restored.');
  process.exit(0);
}

// ---- 5. publish --------------------------------------------------------------

step('Point the site at it, commit, tag');
const apkUrl = `https://github.com/ckadirt/Cantor/releases/download/${tag}/${apkName}`;
writeFileSync(siteFile, appRecord(readFileSync(siteFile, 'utf8'), { versionName, versionCode, apk: apkUrl, sha256, bytes, notes }));
run('git', ['-C', repo, 'add', gradleFile, siteFile]);
run('git', ['-C', repo, 'commit', '-m', `app: ${versionName}`]);
run('git', ['-C', repo, 'tag', tag]);
sh('git', ['-C', repo, 'push', 'origin', tag]);

step(`Publish ${tag} on GitHub`);
const body = [
  notes,
  '',
  `- **Install:** download \`${apkName}\` on your phone and open it, or press Update in Cantor's Settings. Android 7 or later, arm64.`,
  `- **Signing:** Cantor's release key (certificate SHA-256 \`${CANTOR_CERT_SHA256}\`); it installs over earlier versions and keeps your data.`,
  `- **Checksum:** \`${apkName}.sha256\`.`,
].join('\n');
sh('gh', ['release', 'create', tag, '--verify-tag', '--latest=false', '--title', `Cantor for Android ${versionName}`, '--notes', body, apk, `${apk}.sha256`], { cwd: repo });

step('Push main (redeploys cantorfm.com)');
const pushed = spawnSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'inherit' });
if (pushed.status !== 0) {
  fail(`${tag} is published, but main did not push, so the site still points at the old APK. Finish with: git -C ${repo} push origin main`);
}

console.log(`
Published Cantor for Android ${versionName}.
  The site redeploys in a minute or two (deploy-site); then cantorfm.com/download
  and /app/latest.json move to ${versionName}, and installed apps offer the update.
  Watch it: gh run watch $(gh run list --workflow deploy-site --limit 1 --json databaseId --jq '.[0].databaseId')`);

// ---- helpers -----------------------------------------------------------------

function nextVersion(current, how) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'major') return `${major + 1}.0.0`;
  if (!/^\d+\.\d+\.\d+$/.test(how)) fail(`"${how}" is not patch, minor, major or X.Y.Z.`);
  const [a, b, c] = how.split('.').map(Number);
  if (a < major || (a === major && (b < minor || (b === minor && c <= patch)))) fail(`${how} is not after ${current}.`);
  return how;
}

/** The properties file Gradle signs with (`cantorKeystoreProperties`). */
function readKeystoreProperties() {
  const gradleProps = join(homedir(), '.gradle', 'gradle.properties');
  const path = existsSync(gradleProps) ? /^cantorKeystoreProperties=(.+)$/m.exec(readFileSync(gradleProps, 'utf8'))?.[1]?.trim() : undefined;
  if (!path || !existsSync(path)) fail('cantorKeystoreProperties is not set in ~/.gradle/gradle.properties (cantor/README.md, "Signing").');
  const props = Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  for (const key of ['storeFile', 'storePassword', 'keyAlias']) if (!props[key]) fail(`the keystore properties have no ${key}.`);
  props.storeFile = resolve(dirname(path), props.storeFile);
  return props;
}

function keystoreFingerprint({ storeFile, storePassword, keyAlias }) {
  const out = run('keytool', ['-list', '-v', '-keystore', storeFile, '-alias', keyAlias, '-storepass:env', 'CANTOR_STOREPASS'], {
    env: { ...process.env, CANTOR_STOREPASS: storePassword },
  });
  const sha = /SHA256:\s*([0-9A-F:]+)/.exec(out)?.[1];
  if (!sha) fail('keytool printed no SHA-256 for the release key.');
  return sha.replace(/:/g, '').toLowerCase();
}

/** The newest Android build tools, for apksigner and aapt2. */
function buildTools() {
  const local = join(app, 'android', 'local.properties');
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    (existsSync(local) ? /^sdk\.dir=(.+)$/m.exec(readFileSync(local, 'utf8'))?.[1]?.trim() : undefined) ??
    join(homedir(), 'Android', 'Sdk');
  const root = join(sdk, 'build-tools');
  if (!existsSync(root)) fail(`no Android build tools under ${root}`);
  const newest = readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  return join(root, newest);
}

/** docs/src/site.ts with its APP record rewritten. */
function appRecord(source, next) {
  const record = [
    'export const APP = {',
    `  versionName: '${next.versionName}',`,
    `  versionCode: ${next.versionCode},`,
    `  apk: '${next.apk}',`,
    `  sha256: '${next.sha256}',`,
    `  bytes: ${next.bytes},`,
    `  notes: '${next.notes.replace(/'/g, "\\'")}',`,
    '} as const;',
  ].join('\n');
  const updated = source.replace(/export const APP = \{[\s\S]*?\} as const;/, record);
  if (updated === source) fail('could not find the APP record in docs/src/site.ts.');
  return updated;
}
