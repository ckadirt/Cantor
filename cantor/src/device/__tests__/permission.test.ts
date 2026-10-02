import {
  checkMusic,
  musicPermissionName,
  requestMusic,
  type PermissionPort,
} from '../permission';

function port(
  sdk: number,
  granted: boolean,
  answer = 'granted',
): PermissionPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    sdk,
    asked,
    check: jest.fn(async (permission: string) => {
      asked.push(permission);
      return granted;
    }),
    request: jest.fn(async (permission: string) => {
      asked.push(permission);
      return answer;
    }),
    openSettings: jest.fn(async () => undefined),
  };
}

describe('music permission', () => {
  it('names the audio permission from API 33 and storage below', () => {
    expect(musicPermissionName(34)).toBe('android.permission.READ_MEDIA_AUDIO');
    expect(musicPermissionName(33)).toBe('android.permission.READ_MEDIA_AUDIO');
    expect(musicPermissionName(30)).toBe(
      'android.permission.READ_EXTERNAL_STORAGE',
    );
  });

  it('checks without asking', async () => {
    const granted = port(34, true);
    expect(await checkMusic(granted, 'unknown')).toBe('granted');
    expect(granted.request).not.toHaveBeenCalled();
    expect(await checkMusic(port(34, false), 'unknown')).toBe('unknown');
  });

  it('keeps what a request learned until a check finds it granted', async () => {
    expect(await checkMusic(port(34, false), 'blocked')).toBe('blocked');
    expect(await checkMusic(port(34, false), 'denied')).toBe('denied');
    expect(await checkMusic(port(34, true), 'blocked')).toBe('granted');
    // Withdrawn in Android's settings while Cantor ran.
    expect(await checkMusic(port(34, false), 'granted')).toBe('denied');
  });

  it("reads Android's three answers", async () => {
    expect(await requestMusic(port(34, false, 'granted'))).toBe('granted');
    expect(await requestMusic(port(34, false, 'denied'))).toBe('denied');
    expect(await requestMusic(port(28, false, 'never_ask_again'))).toBe(
      'blocked',
    );
  });
});
