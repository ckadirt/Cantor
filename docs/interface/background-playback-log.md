# Background playback implementation

Date: 2026-10-05.

## Milestones

| Milestone | Result |
| --- | --- |
| 1: lifecycle investigation | The original release's Recents removal stopped its service/media session. React Native's delegate also stops its surface on activity destruction. A service flag alone therefore cannot preserve this React-owned player and queue. |
| 2: retain playback | An application-owned surface retains the existing React tree during playback, detaches its window/context on activity destruction, and reattaches on reopening. The service uses `stopWithTask=false`. |
| 3: notification shutdown | Stop and dismissal close playback, hide the notification, release focus, and release a detached surface. Stop also rejects late file resolution and duration inspection. The library patch supplies a separate Stop button and Android 13+ custom media action. |
| 4: verification | JavaScript and Android checks pass. Physical release-build checks cover task removal, multiple natural queue transitions, reopening, and notification controls. Detailed evidence and remaining device coverage appear below. |

## Queue preservation

`src/field/queue.ts`, `src/features/field/useShelfQueue.ts`, and
`src/player/afterSong.ts` are unchanged. The existing queue tests are unchanged
and pass. No native queue, persistent queue, new storage key, migration, or
wire-protocol change was introduced. Group selection, order, tickets, refusal
policy, and prefetch remain in their existing owner.

`FieldScreen` only wraps file resolution in a playback-lifetime guard and marks
deliberate UI play/step actions as permission to start a session after Stop.
The native owner retains the whole tree deliberately: extracting or duplicating
the queue would conflict with the requested scope.

## Automated verification

- `npx tsc --noEmit`: passed.
- `npx eslint .`: no errors; warnings remain in existing code and generated
  Android test-report JavaScript. No new warnings in the changed implementation.
- `npx jest --runInBand`: 122 suites, 1,371 tests, and 15 snapshots passed.
- `./gradlew app:testDebugUnitTest app:assembleDebug app:assembleRelease
  -PreactNativeArchitectures=arm64-v8a`: passed; 18 native tests, no failures.
- `npx patch-package --error-on-fail`: both existing dependency patches apply.
- `git diff --check`: passed; protected queue files have no diff.
- The merged release manifest confirms `stopWithTask=false`.

New tests cover Stop during duration inspection and element loading, late native
events, stale downloads across a new session, notification work finishing before
shutdown, surface reuse across activities, replacing the activity context, and
releasing a detached surface exactly once.

## Physical-device evidence

Device: Xiaomi 2201116PG (`6b1f6ba8629c`), Android 13. Both debug and release
APKs build; the physical checks use the self-contained release APK installed
with `adb install -r`, preserving app data and without relying on Metro.

- Baseline: swiping the Cantor card out of MIUI Recents removed the activity,
  foreground service, and Cantor media session.
- With the new lifetime: the activity/task disappeared from `dumpsys activity`,
  while the same process and foreground service continued playing. Natural
  endings advanced from **Quiet piano - canvas verification** to **kshmr intro**
  and then **Summer song bass**, matching the visible shelf order.
- Reopening kept the same media-session process and showed **Summer song bass**
  at its current position, rather than restarting it. A window-color regression
  found here was corrected by reapplying the status bar on activation.
- The Android 13 media session advertises Stop as a custom action, alongside
  the existing actions. The notification visibly offers Stop, previous,
  pause/play, and next.
- System media Stop removed the session and foreground service; a deliberate
  UI Play subsequently started playback normally.
- On the final release, after removing the task and turning the screen off,
  `dumpsys deviceidle force-idle` reported `mState=IDLE`. Playback continued
  through several natural endings in the same shelf. Idle forcing was then
  removed; the phone returned to `ACTIVE`.
- Pause retained the detached session and foreground service; Play resumed it.
  The visible square Stop button was then tapped in the notification with no
  Cantor activity present. The media session and foreground service disappeared,
  and `dumpsys audio` showed an empty audio-focus stack. No native/JS crash was
  reported during these checks.
- A final paused-session reopen reused the same process/session and displayed
  the retained 8-second position. The new activity's status bar used the correct
  white background. The updated release remains installed; test playback was
  stopped after verification.

## Coverage limits

Automated tests cover shutdown races; real-device checks do not inject every
possible network/download failure. Existing queue/refusal tests still cover the
unchanged policies. This pass does not establish long-duration battery behavior
across manufacturers, or test every imported-file codec. No changes were made
to imported-file playback, encrypted downloading, or recovery policy.

Force stop, OS process death, and reboot terminate playback. This feature keeps
the live session through UI/task closure; it does not restore that session after
process death.

Platform references: [background playback](https://developer.android.com/media/media3/session/background-playback)
and [Android media controls](https://developer.android.com/media/implement/surfaces/mobile).
