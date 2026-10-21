/** Links the landing and the docs share, in one place. */
export const SITE = {
  /** The install line people copy. cantorfm.com redirects it to the relay's copy. */
  install: 'curl -fsSL https://cantorfm.com/install.sh | sh',
  /**
   * The Android app: the arm64 APK on its own `app-v…` release. Bump it with
   * each published APK (cantor/README.md, "Publishing the APK").
   */
  apk: 'https://github.com/ckadirt/Cantor/releases/download/app-v0.1.0/cantor-0.1.0-arm64.apk',
  github: 'https://github.com/ckadirt/Cantor',
} as const;
