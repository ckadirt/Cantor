import type { ErrorCode } from '../../../../../protocol/ErrorCode';
import {
  describeConnection,
  describeError,
  describeFailure,
} from '../describeError';
import { ERROR_CODES } from '../jobs';

/** Every code the protocol has, written out so a new one fails this test. */
const ALL: Record<ErrorCode, true> = {
  unsupported_version: true,
  unauthenticated: true,
  rejected: true,
  invalid_request: true,
  not_found: true,
  model_not_installed: true,
  model_unavailable: true,
  idempotency_conflict: true,
  queue_full: true,
  insufficient_disk: true,
  temporarily_unavailable: true,
  feature_unavailable: true,
  revision_conflict: true,
  full_sync_required: true,
  invalid_transition: true,
  checkpoint_unavailable: true,
  artifact_unavailable: true,
  artifact_changed: true,
  invalid_offset: true,
  transfer_expired: true,
  internal: true,
};

describe('words from codes, never from exceptions', () => {
  it('has a sentence and a next step for every ErrorCode', () => {
    expect(new Set(Object.keys(ALL))).toEqual(new Set(ERROR_CODES));
    for (const code of Object.keys(ALL) as ErrorCode[]) {
      const words = describeError(code, 'agentbox');
      expect(words.short.length).toBeGreaterThan(0);
      expect(words.state).toBe(words.short.toUpperCase());
      expect(words.sentence).toMatch(/[.]$/);
      // A code reached the table only if it is not the generic fallback, or
      // is the fallback itself.
      if (code !== 'internal')
        expect(words.short).not.toBe('Something broke on agentbox');
    }
  });

  it('follows the folio table', () => {
    expect(describeError('temporarily_unavailable', 'agentbox')).toMatchObject({
      state: 'AGENTBOX LEFT',
      next: 'none',
      held: true,
    });
    expect(describeError('insufficient_disk', 'h100').state).toBe(
      'NO SPACE ON H100',
    );
    expect(describeError('queue_full', 'h100')).toMatchObject({
      state: 'H100 IS BUSY',
      next: 'again',
    });
    expect(describeError('transfer_expired', 'agentbox')).toMatchObject({
      state: 'THE FILE CHANGED',
      next: 'start-again',
    });
    expect(describeError('rejected', 'agentbox').next).toBe('pair');
    expect(describeError('internal', 'h100', true).next).toBe('again');
    expect(describeError('internal', 'h100', false).next).toBe('dismiss');
    expect(describeError('something_new', 'h100').state).toBe(
      'SOMETHING BROKE ON H100',
    );
  });

  it('reads a thrown error by its code, and the phone’s own by what it means', () => {
    const refused = Object.assign(new Error('raw node text'), {
      code: 'queue_full',
      retryable: true,
    });
    expect(describeFailure(refused, 'h100').state).toBe('H100 IS BUSY');
    const offline = describeFailure(
      new Error('The node is not ready.'),
      'agentbox',
    );
    expect(offline.state).toBe('AGENTBOX IS OFFLINE');
    expect(offline.sentence).not.toContain('not ready');
    expect(
      describeFailure(new Error('Song detail timed out.'), 'agentbox').state,
    ).toBe('AGENTBOX DID NOT ANSWER');
    expect(describeConnection('Relay rejected the connection.', 'x').next).toBe(
      'pair',
    );
    expect(describeConnection('socket closed', 'x').held).toBe(true);
  });
});
