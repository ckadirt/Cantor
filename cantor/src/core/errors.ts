/** Converts any thrown value into the user-safe text used throughout the app. */
export function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
