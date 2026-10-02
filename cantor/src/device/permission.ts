import { Linking, PermissionsAndroid, Platform } from 'react-native';

/**
 * Whether Cantor may read the phone's music (docs/import/flow-plan.md, I7c).
 *
 * `unknown`: never asked in this run, or asked and not yet answered.
 * `denied`: refused, and Android will ask again. `blocked`: refused for good
 * (`never_ask_again`); only Android's settings can change it.
 *
 * Android's own check says only granted or not, so `denied` and `blocked`
 * are learned from a request. A refusal is remembered for the run and
 * replaced by the next check that finds the permission granted.
 */
export type MusicPermission = 'unknown' | 'granted' | 'denied' | 'blocked';

/** The part of `PermissionsAndroid` used here, so tests can stand in for it. */
export type PermissionPort = Readonly<{
  sdk: number;
  check(permission: string): Promise<boolean>;
  request(permission: string): Promise<string>;
  openSettings(): Promise<void>;
}>;

export const androidPermissions: PermissionPort = {
  sdk: Platform.OS === 'android' ? Number(Platform.Version) : 0,
  check: permission =>
    PermissionsAndroid.check(
      permission as Parameters<typeof PermissionsAndroid.check>[0],
    ),
  request: permission =>
    PermissionsAndroid.request(
      permission as Parameters<typeof PermissionsAndroid.request>[0],
    ),
  openSettings: () => Linking.openSettings(),
};

/** `READ_MEDIA_AUDIO` from API 33, `READ_EXTERNAL_STORAGE` below. */
export function musicPermissionName(sdk: number): string {
  return sdk >= 33
    ? 'android.permission.READ_MEDIA_AUDIO'
    : 'android.permission.READ_EXTERNAL_STORAGE';
}

/** What a check says, given what the run already learned from a request. */
export async function checkMusic(
  port: PermissionPort,
  previous: MusicPermission,
): Promise<MusicPermission> {
  if (await port.check(musicPermissionName(port.sdk))) return 'granted';
  return previous === 'granted' ? 'denied' : previous;
}

/** Ask Android; it shows its dialog unless the answer is already final. */
export async function requestMusic(
  port: PermissionPort,
): Promise<MusicPermission> {
  const answer = await port.request(musicPermissionName(port.sdk));
  if (answer === 'granted') return 'granted';
  return answer === 'never_ask_again' ? 'blocked' : 'denied';
}
