import type { ErrorCode } from '../../../../protocol/ErrorCode';

/**
 * What a failure offers, in the place it is written (`folio.html#errors`).
 *
 * | Next | Means |
 * | --- | --- |
 * | `none` | nothing to do: it sorts itself out (drawn with the fermata) |
 * | `again` | the same act may work if tried again |
 * | `dismiss` | it will not work; say so and let it go |
 * | `start-again` | what was half done has to begin from the start |
 * | `node` | the answer is on the node's page |
 * | `pair` | this phone has to pair with the node again |
 */
export type ErrorNext =
  | 'none'
  | 'again'
  | 'dismiss'
  | 'start-again'
  | 'node'
  | 'pair';

/** A failure in the app's own words. Never the raw message. */
export type ErrorWords = Readonly<{
  /** Short, in sentence case, no full stop: the word an act morphs into. */
  short: string;
  /** The same, as a state line in mono capitals. */
  state: string;
  /** One sentence in Spectral, for a row or a coda. */
  sentence: string;
  next: ErrorNext;
  /**
   * Waiting rather than broken: the fermata, no action asked. Only a node
   * that left, or a sync catching up, is held.
   */
  held: boolean;
}>;

function words(
  short: string,
  sentence: string,
  next: ErrorNext,
  held = false,
): ErrorWords {
  return { short, state: short.toUpperCase(), sentence, next, held };
}

/**
 * One sentence and one next step per `ErrorCode`, naming the node it is
 * about. `retryable` decides between `again` and `dismiss` where the code
 * alone does not. An unknown code is read as `internal`.
 */
export function describeError(
  code: ErrorCode | string,
  node: string,
  retryable = false,
): ErrorWords {
  const again: ErrorNext = retryable ? 'again' : 'dismiss';
  switch (code as ErrorCode) {
    case 'temporarily_unavailable':
      return words(
        `${node} left`,
        `${node} went away for now. This resumes by itself when it is back.`,
        'none',
        true,
      );
    case 'insufficient_disk':
      return words(
        `No space on ${node}`,
        `${node} has no room left for this.`,
        'dismiss',
      );
    case 'queue_full':
      return words(
        `${node} is busy`,
        `${node} has as much work as it will take. Try again in a while.`,
        'again',
      );
    case 'model_not_installed':
    case 'model_unavailable':
      return words(
        'Not on this node any more',
        `That model is not on ${node} any more.`,
        'node',
      );
    case 'artifact_changed':
    case 'transfer_expired':
    case 'invalid_offset':
      return words(
        'The file changed',
        `The file on ${node} changed while it was on its way. It has to start again.`,
        'start-again',
      );
    case 'checkpoint_unavailable':
      return words(
        'Cannot pick it up',
        `${node} cannot carry on from where this stopped. It has to start again.`,
        'start-again',
      );
    case 'artifact_unavailable':
    case 'not_found':
      return words(
        `Not on ${node} any more`,
        `This is not on ${node} any more.`,
        'dismiss',
      );
    case 'unauthenticated':
    case 'rejected':
      return words(
        `${node} no longer knows this phone`,
        `${node} no longer knows this phone. Pair with it again.`,
        'pair',
      );
    case 'unsupported_version':
      return words(
        `${node} needs an update`,
        `${node} needs an update before it can do this.`,
        'node',
      );
    case 'feature_unavailable':
      return words(
        `${node} cannot do this`,
        `${node} does not do this yet. An update may add it.`,
        'node',
      );
    case 'invalid_request':
      return words(
        `${node} refused it`,
        `${node} could not accept what was sent.`,
        'dismiss',
      );
    case 'idempotency_conflict':
      return words('Already sent', `${node} already has this one.`, 'dismiss');
    case 'revision_conflict':
      return words(
        'Changed elsewhere',
        `This was changed on another phone first. Try again.`,
        'again',
      );
    case 'full_sync_required':
      return words(
        `Catching up with ${node}`,
        `${node} is sending its whole library again. Nothing is asked of you.`,
        'none',
        true,
      );
    case 'invalid_transition':
      return words(
        'Not now',
        `That cannot be done to it in the state it is in.`,
        'dismiss',
      );
    default:
      return words(
        `Something broke on ${node}`,
        retryable
          ? `Something broke on ${node}. It may work if you try again.`
          : `Something broke on ${node}.`,
        again,
      );
  }
}

/**
 * Words for anything thrown at the app: a node's refusal by its code, and the
 * phone's own failures — no socket, no answer — by what they mean. The thrown
 * message itself is for Diagnostics, never for the screen.
 */
export function describeFailure(error: unknown, node: string): ErrorWords {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const coded = error as { code: string; retryable?: unknown };
    return describeError(coded.code, node, coded.retryable === true);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not (ready|connected)|offline/i.test(message))
    return words(
      `${node} is offline`,
      `${node} cannot be reached right now.`,
      'again',
    );
  if (/timed? ?out/i.test(message))
    return words(
      `${node} did not answer`,
      `${node} did not answer in time. Try again.`,
      'again',
    );
  return describeError('internal', node, true);
}

/**
 * Words for why a node's connection is down, from the connection's own text
 * (it carries no code). A refusal asks for pairing again; anything else is
 * the phone trying again by itself, which is held.
 */
export function describeConnection(message: string, node: string): ErrorWords {
  if (/reject|unauth|unknown phone|not paired/i.test(message))
    return describeError('rejected', node);
  return words(
    `Trying ${node} again`,
    `${node} could not be reached. The phone keeps trying by itself.`,
    'none',
    true,
  );
}
