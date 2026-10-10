/**
 * Where the sound goes, as far as its delay is concerned.
 *
 * react-native-audio-api reports no output latency: its Oboe stream is opened
 * low-latency and exclusive, but `calculateLatencyMillis` is never asked, and a
 * file source's `currentTime` is the position the audio thread has *rendered*,
 * not the one in the air. So the delay is a constant per route, measured on the
 * phones (docs/interfacealpha/reactive-player-log.md, M1).
 */
export type OutputRoute = 'speaker' | 'wired' | 'usb' | 'bluetooth' | 'other';

// knobs
/**
 * Seconds from a frame rendered into the output to its sound in the air, less
 * how long a drawn frame takes to reach the glass. The flash test measures the
 * two together, so this one number per route is what it calibrates.
 *
 * UNMEASURED: estimates until the flash test runs on both phones. Bluetooth
 * varies by codec and headset; 0.2 s is the middle of the usual 150–250 ms.
 */
const OUTPUT_LATENCY_SECONDS: Readonly<Record<OutputRoute, number>> = {
  speaker: 0.04,
  wired: 0.03,
  usb: 0.03,
  bluetooth: 0.2,
  other: 0.04,
};

export function outputLatencySeconds(route: OutputRoute | null): number {
  return OUTPUT_LATENCY_SECONDS[route ?? 'speaker'];
}

const ROUTES: readonly OutputRoute[] = ['speaker', 'wired', 'usb', 'bluetooth', 'other'];

/** Check what the native module resolved with; anything else is `other`. */
export function toOutputRoute(value: unknown): OutputRoute {
  return ROUTES.includes(value as OutputRoute) ? (value as OutputRoute) : 'other';
}
