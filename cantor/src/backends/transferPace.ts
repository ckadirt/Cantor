/**
 * How many slices of a transfer may be in flight at once.
 *
 * A slice costs a round trip through the relay, so sending one at a time caps a
 * transfer at `slice / round trip` however wide the connection is. The node
 * answers each request as it arrives, so the app simply asks ahead, as SFTP
 * does: the window lives here, and the node keeps no state for it.
 *
 * The window opens by one per settled slice, which doubles it every round trip,
 * until it holds as much as the connection delivers in `IN_FLIGHT_BUDGET_MS`.
 * That cap is what makes a wide window safe: on a slow link a fixed one would
 * leave its last slice queued past the request timeout, and the relay, which
 * has no backpressure of its own, would be holding the backlog.
 */

/** KNOBS */
export const TRANSFER_PACE_KNOBS = {
  /** Where every transfer starts, before anything is known about the link. */
  INITIAL_WINDOW: 4,
  /** The window never closes below this, so a measured stall can recover. */
  MIN_WINDOW: 2,
  /** The most a transfer holds in flight, whatever the link can carry. */
  MAX_IN_FLIGHT_BYTES: 8 * 1024 * 1024,
  /** In-flight work may take this long at the measured rate. */
  IN_FLIGHT_BUDGET_MS: 2_000,
  /** How much history one rate measurement covers. */
  RATE_SAMPLE_MS: 500,
} as const;

export class TransferPace {
  private current: number = TRANSFER_PACE_KNOBS.INITIAL_WINDOW;
  private readonly most: number;
  private sampleStart: number | null = null;
  private sampleBytes = 0;
  private rateLimit = Infinity;

  constructor(
    private readonly chunkBytes: number,
    private readonly now: () => number = Date.now,
  ) {
    this.most = Math.max(
      TRANSFER_PACE_KNOBS.MIN_WINDOW,
      Math.floor(TRANSFER_PACE_KNOBS.MAX_IN_FLIGHT_BYTES / chunkBytes),
    );
  }

  /** How many slices may be unsettled right now. */
  get window(): number {
    return Math.min(this.current, this.rateLimit, this.most);
  }

  /** One slice has fully landed: it was answered and, on a download, written. */
  settled(bytes: number): void {
    const at = this.now();
    this.sampleStart ??= at;
    this.sampleBytes += bytes;
    this.current = Math.min(this.current + 1, this.most);
    const elapsed = at - this.sampleStart;
    if (elapsed < TRANSFER_PACE_KNOBS.RATE_SAMPLE_MS) return;
    const budgetBytes =
      (this.sampleBytes / elapsed) * TRANSFER_PACE_KNOBS.IN_FLIGHT_BUDGET_MS;
    this.rateLimit = Math.max(
      TRANSFER_PACE_KNOBS.MIN_WINDOW,
      Math.ceil(budgetBytes / this.chunkBytes),
    );
    this.sampleStart = at;
    this.sampleBytes = 0;
  }
}
