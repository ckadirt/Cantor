# Cantor

A new way to interact with music. Cantor generates full songs on-device — no cloud inference required — built on the ACE-Step 1.5 music model. This repo is the **React Native app** (RN 0.86, bare CLI, `applicationId com.cantor.app`).

> **Generation runs where you are.** The generation engine is being disentangled from the app so a song can be produced on **local devices (smartphones)**, on a **PC or Mac**, and — coming soon — on **our own servers**. Same app, interchangeable backends. This is core to the philosophy: revolutionize how we interact with music by letting the music be made anywhere.

---

## Prerequisites

- Node.js + npm
- JDK 17
- Android SDK (this machine: `android/local.properties` sets `sdk.dir`; `ANDROID_HOME` is unset)
- Android NDK **r27b** (r30 is beta — don't use it)
- A connected device or emulator (`adb devices` should list it)

Make sure you've completed the RN [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide once.

Install JS dependencies:

```sh
npm install
```

---

## The local server (Metro)

"The local server" is **Metro**, the JavaScript bundler/dev server. Debug builds load their JS bundle from it live, so it must be running while you develop.

```sh
# from cantor/ (the repo root)
npm start
```

That runs `react-native start` on **port 8081**. Leave it running in its own terminal.

If it gets into a weird state after adding native deps or changing Babel config, reset its cache:

```sh
npx react-native start --reset-cache
```

### Let a USB-connected phone reach Metro

A device on USB has to forward port 8081 back to your machine:

```sh
adb reverse tcp:8081 tcp:8081
```

> **Trap:** unplugging/replugging USB drops the reverse mapping. The app then red-screens *"Unable to load script"* on the next cold start. Just re-run the `adb reverse` line above.

---

## Debug build

A debug APK is signed with the bundled `debug.keystore` and loads its JS from Metro (hot reload works).

**One command (build + install + launch)** — Metro must be running:

```sh
npm run android
```

**Or build and install the APK by hand:**

```sh
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> First Gradle build is slow (~16 min); it's cached after that. Adding new native dependencies forces a full rebuild (~8–9 min) — pair it with `--reset-cache` on Metro.

### Debugging workflow

- **Metro running?** Debug builds need it (see above), plus `adb reverse tcp:8081 tcp:8081` over USB.
- **Open the Dev Menu:** `adb shell input keyevent 82` (or shake the device / <kbd>Ctrl</kbd>+<kbd>M</kbd>).
- **Fast Refresh:** save a file and the app updates automatically.
- **Full reload:** press <kbd>R</kbd> twice, or "Reload" in the Dev Menu.
- **Screenshot to verify on-device:** `adb exec-out screencap -p > shot.png`.
- **Native resource changes** (icons, manifest, anything under `android/`) are **not** hot-reloaded — rebuild with Gradle.

---

## Production / release build

The release build minifies (ProGuard), doesn't need Metro, and ships a self-contained JS bundle.

> ⚠️ **Signing:** `android/app/build.gradle` currently signs `release` with the **debug keystore** (RN template default). Before publishing to Play, generate your own upload keystore and wire it into `signingConfigs.release` — see [Signing your app](https://reactnative.dev/docs/signed-apk-android). Until then a release build is fine for local testing but **not** distributable.

**Release APK** (for sideloading / direct install):

```sh
cd android
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

**Release AAB** (Android App Bundle — the format Google Play wants):

```sh
cd android
./gradlew bundleRelease
# output: android/app/build/outputs/bundle/release/app-release.aab
```

Run a release build directly on a device:

```sh
npm run android -- --mode=release
```

Version is set in `android/app/build.gradle` (`versionCode` / `versionName`) — bump both before a release.

---

## Tests & lint

```sh
npm test      # Jest
npm run lint  # ESLint
```

---

## Troubleshooting

- **"Unable to load script" red screen** → Metro isn't running or `adb reverse` was dropped. Start Metro and re-run `adb reverse tcp:8081 tcp:8081`.
- **Metro 500s after native/Babel changes** → `npx react-native start --reset-cache`.
- **Weird NDK/CMake failures** → the workspace path contains a space (`step-ace 1.5`); suspect that first. Also confirm you're on NDK **r27b**, not the beta r30.
- General RN issues: [Troubleshooting](https://reactnative.dev/docs/troubleshooting).
