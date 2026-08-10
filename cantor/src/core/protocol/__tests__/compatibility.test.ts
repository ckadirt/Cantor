import * as legacy from '../../../backends/types';
import { isRecord } from '../../validation';
import * as protocol from '..';

describe('backend protocol compatibility façade', () => {
  it('re-exports the inward-facing constants and validators unchanged', () => {
    expect(legacy.APPLICATION_PROTOCOL_VERSION).toBe(
      protocol.APPLICATION_PROTOCOL_VERSION,
    );
    expect(legacy.RELAY_PROTOCOL_VERSION).toBe(protocol.RELAY_PROTOCOL_VERSION);
    expect(legacy.isRecord).toBe(isRecord);
    expect(legacy.parseArtifact).toBe(protocol.parseArtifact);
    expect(legacy.parseJob).toBe(protocol.parseJob);
    expect(legacy.parseJobs).toBe(protocol.parseJobs);
    expect(legacy.parseLibraryChanges).toBe(protocol.parseLibraryChanges);
    expect(legacy.parseNodeInfo).toBe(protocol.parseNodeInfo);
    expect(legacy.parseSong).toBe(protocol.parseSong);
    expect(legacy.parseSongDetail).toBe(protocol.parseSongDetail);
    expect(legacy.parseSongs).toBe(protocol.parseSongs);
  });
});
