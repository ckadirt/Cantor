package com.cantor.app.security

/**
 * Where a transfer starts: about a megabyte, so a small file is not over before
 * the window has opened. A chunk resets the stall limit as it lands, so even a
 * slow link only has to deliver the first one in time.
 */
private const val INITIAL_WINDOW = 16
/** The window never closes below this, so a measured stall can recover. */
private const val MIN_WINDOW = 2
/** The most a transfer holds in flight, whatever the link can carry. */
private const val MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024
/** In-flight work may take this long at the measured rate. */
private const val IN_FLIGHT_BUDGET_MS = 2_000.0
private const val RATE_SAMPLE_MS = 500L

/**
 * How many slices of a transfer may be in flight at once.
 *
 * A slice costs a round trip through the relay, so one at a time caps a transfer
 * at `slice / round trip` however wide the connection is. The window opens by
 * one per settled slice, doubling every round trip, until it holds what the link
 * delivers in [IN_FLIGHT_BUDGET_MS]. That cap keeps a slow link's last slice
 * inside the stall limit, and keeps the relay, which has no backpressure of its
 * own, from holding the backlog.
 */
internal class TransferPace(
    private val chunkBytes: Int,
    private val now: () -> Long = System::currentTimeMillis,
) {
  private val most = maxOf(MIN_WINDOW, MAX_IN_FLIGHT_BYTES / chunkBytes)
  private var current = INITIAL_WINDOW
  private var rateLimit = Int.MAX_VALUE
  private var sampleStart = -1L
  private var sampleBytes = 0L

  val window: Int
    get() = minOf(current, rateLimit, most)

  /** One slice has fully landed: answered and, on a download, written. */
  fun settled(bytes: Int) {
    val at = now()
    if (sampleStart < 0) sampleStart = at
    sampleBytes += bytes
    current = minOf(current + 1, most)
    val elapsed = at - sampleStart
    if (elapsed < RATE_SAMPLE_MS) return
    val budgetBytes = sampleBytes.toDouble() / elapsed * IN_FLIGHT_BUDGET_MS
    rateLimit = maxOf(MIN_WINDOW, Math.ceil(budgetBytes / chunkBytes).toInt())
    sampleStart = at
    sampleBytes = 0
  }
}
