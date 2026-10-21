/** Links the landing and the docs share, in one place. */
export const SITE = {
  /** The install line people copy. cantorfm.com redirects it to the relay's copy. */
  install: 'curl -fsSL https://cantorfm.com/install.sh | sh',
  /**
   * Where the Android app comes from. No APK is published yet: until one is,
   * this is the releases page.
   */
  apk: 'https://github.com/ckadirt/Cantor/releases',
  github: 'https://github.com/ckadirt/Cantor',
} as const;
