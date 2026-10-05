# Playback after closing the app

Status: implemented; see [implementation and verification log](background-playback-log.md).
The sections below retain the original milestone scope and acceptance criteria.

## Goal

On Android, music continues when Cantor goes into the background, the screen
locks, or the user swipes Cantor out of Recents. The playback notification
remains usable until the user explicitly stops playback from it. Reopening
Cantor shows the current track and position without restarting playback.

Android Force stop, the system's explicit stop control, device shutdown, and
process death are separate cases. This work does not promise playback through
those events or automatic playback after a restart.

## Hard constraint: preserve the queue

Do not change the queue's code, algorithm, grouping, initial seating, live-layout
fallback, next/previous behavior, after-song modes, refusal handling, prefetch
policy, or play-ticket behavior. Keep `src/field/queue.ts`,
`src/features/field/useShelfQueue.ts`, and `src/player/afterSong.ts` unchanged.
Notification next/previous must use the same existing callbacks as today.
Do not introduce a second native queue or a saved queue for this feature.

If reliable task removal requires moving or changing queue ownership, record
the evidence and revisit this plan with the user before making that change.
Finishing only the currently playing song is not sufficient acceptance.

## Current implementation and uncertainty

- `cantor/android/app/src/main/AndroidManifest.xml` declares the audio library's
  media-playback foreground service with `android:stopWithTask="true"`.
- `src/player/PlayerHost.tsx` renders the library's `<Audio>` element and wires
  audio-session activity, interruptions, and notification controls. Its cleanup
  hides the notification and deactivates the session.
- `PlayerHost`, `usePlayer`, and `useShelfQueue` are currently wired in
  `src/screens/FieldScreen.tsx`. Keeping only the Android service alive does not
  establish that this React tree and its callbacks survive task removal.
- `src/player/createAudioApiPlayer.ts` declares play, pause, seek, next, and
  previous controls. Stop and notification dismissal are not wired there today.
- The installed `react-native-audio-api` service returns `START_NOT_STICKY`.
  Its notification receiver forwards dismissal to JavaScript. Existing native
  fixes are maintained in `cantor/patches/react-native-audio-api+0.13.3.patch`.
- The contributor guide records successful screen-off/doze queue advancement.
  That is useful prior evidence, not proof of survival after removing the task.

Expected difficulty: moderate if the existing runtime survives task removal;
larger if Android activity destruction tears down the player host. Milestone 1
determines the path before committing to an architecture change.

## Milestone 1 — Establish lifecycle behavior

**Work**

1. Read the app architecture and audio guide, the existing dependency patch,
   and native/React teardown paths. Confirm the merged manifest's service flags.
2. On the physical Android phone, record the baseline for Home, screen lock,
   Recents removal, and reopening during playback. Inspect the activity,
   service, React runtime, player host, notification, and ended callbacks.
3. In an isolated experiment, disable `stopWithTask` and repeat the same cases,
   including at least two consecutive track transitions after task removal.
4. Check whether reopening creates another player or resets the existing queue.
   Use a release build as well as debug so Metro does not mask lifecycle issues.

**Deliverable:** a short evidence log and a concrete implementation decision.

**Exit gate:** demonstrate whether service configuration alone preserves the
existing player and queue. If it does not, identify the smallest playback-host
lifecycle change that preserves the queue untouched. If no such route exists,
stop implementation and report the constraint conflict.

## Milestone 2 — Keep the playback session alive

Depends on milestone 1.

**Work**

1. Apply the verified service/task-removal configuration.
2. If the evidence requires it, retain the audio host and session independently
   of activity presentation, without duplicating the player, relocating the
   queue, or changing queue callbacks.
3. Separate activity disappearance from explicit playback shutdown where
   necessary. Preserve existing foreground-start timing and placeholder
   notification fixes.
4. Keep foreground-service lifetime tied to a real playback session. Do not
   add restart loops or boot-time playback.
5. Maintain any necessary dependency modification through the existing
   versioned patch rather than leaving an edit only in `node_modules`.

**Deliverable:** playback survives task removal with the existing queue intact.

**Exit gate:** multiple songs advance after Recents removal; reopening retains
the same session, track, position, and group context. No duplicate audio,
notification, listeners, or foreground-service startup crash.

## Milestone 3 — Stop playback from the notification

Depends on milestone 2.

**Work**

1. Verify the library's Stop and dismissal events, Android notification action
   layout, and delivery after task removal before selecting the control wiring.
2. Provide an explicit Stop action that closes the playback session, releases
   audio focus, removes the notification, and stops the foreground service.
3. Make shutdown safe when repeated or racing a track load/download. A late
   completion must not restart audio or recreate the notification after Stop.
   Use playback/session cancellation; do not alter queue ticket semantics.
4. Where Android permits notification dismissal, route dismissal to the same
   shutdown path. If dismissal is unavailable while playing, Stop remains the
   dependable way to close playback.
5. Keep Pause distinct from Stop: Pause retains resumable session controls.
   Preserve existing interruption behavior and after-song modes; do not force
   continuation or repeat to keep the service active.

**Deliverable:** the user can end background playback from the notification.

**Exit gate:** Stop works with the app visible, backgrounded, locked, and
removed from Recents, including during a source swap or download. No orphan
service and no playback resurrection. A later deliberate play starts normally.

## Milestone 4 — Verify and document the complete behavior

Depends on milestones 2 and 3.

Run this matrix on the physical phone, with release-build task-removal checks:

| Scenario | Required result |
| --- | --- |
| Home and screen lock | Audio and existing media controls keep working |
| Recents removal while playing | Playback and notification survive |
| Multiple endings after Recents removal | Existing group/order and after-song behavior are preserved |
| Notification next/previous | Same results as the current app, including previous restarting after three seconds |
| Pause, then resume after task removal | Same track/session resumes without duplicates |
| Stop or permitted dismissal | Audio ends, notification disappears, service releases |
| Stop during download/source swap | Late work cannot restart playback |
| Reopen during background playback | Current track and position appear without replay or queue reset |
| Cached/imported songs with no network | Existing local-path playback continues |
| Next song needs an encrypted download | Existing fetch/recovery policy applies; no plaintext path is added |
| Interruption or unavailable song | Existing pause/refusal/error behavior remains |
| Doze and manufacturer battery management | Record observed behavior and any device-specific limits |
| Force stop, then manual reopen | No automatic playback resurrection |

**Checks**

- Run the existing queue tests unchanged as regression checks; add focused
  lifecycle/shutdown tests only for new behavior, especially late completion
  after Stop. Unit tests alone do not establish Android task-removal survival.
- From `cantor/`: `npx tsc --noEmit`, `npx eslint .`, and `npx jest --runInBand`.
- From `cantor/android/`: `./gradlew app:testDebugUnitTest app:assembleDebug
  -PreactNativeArchitectures=arm64-v8a`; build and install release using the
  repository's documented workflow for the physical-phone checks.
- Run `git diff --check` and inspect the diff to confirm protected queue files
  and queue settings have not changed.
- Update `docs/refactor/hacking-app.md` with verified ownership, shutdown,
  notification, and reopening behavior; record device/build details and results.

**Exit gate:** the matrix passes, relevant checks pass, the queue is unchanged,
and the evidence supports the documented lifecycle behavior.

## Scope and completion

This is an Android app/player lifecycle feature. No node, relay, transport,
cryptographic, storage-key, database migration, motion, or queue redesign is
planned. Preserve native bridge contracts and existing recovery policies.

Complete means continued playback through multiple queue transitions after
closing the UI, working notification controls and Stop, correct reopening, and
physical-device evidence. A manifest-only change without those checks is not
complete.

Android reference: [Background playback with a MediaSessionService](https://developer.android.com/media/media3/session/background-playback).
This describes the platform lifecycle model; it does not imply that Cantor
must migrate its current audio engine to Media3.
