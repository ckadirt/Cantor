import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import fixture from '../../../../protocol/fixtures/v2/derived-job-id.json';
import { derivedJobId } from '..';

it.each(fixture.vectors)(
  'derives $job_id from the authenticated key and exact request bytes',
  vector => {
    const principal = sha256(hexToBytes(vector.client_public_key_hex));
    expect(derivedJobId(principal, vector.client_request_id)).toBe(
      vector.job_id,
    );
  },
);
