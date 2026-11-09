import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The tag every exported file carries first (`CANTOR`, D5 in
 * internal/docs/plans/take-it-plan.md), so a scan can tell a copy Cantor saved
 * from a song of the person's own and never import it as a second song.
 *
 * `v1;<node tag>;<song id>;<digest>`. The node is a tag, not its key: the file
 * travels to other people when it is shared, and a node's public key is not
 * theirs to have. A phone that knows the node computes the same tag and
 * recognises the song; anyone else learns nothing about where it was made.
 *
 * A compatibility contract, like any byte that leaves the app: files already
 * out in the world carry `v1` for good.
 */
const VERSION = 'v1';

/** Hex characters of the node key's SHA-256 kept: 128 bits, plenty to match. */
const NODE_TAG_HEX = 32;

const SONG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const NODE_TAG = new RegExp(`^[0-9a-f]{${NODE_TAG_HEX}}$`);

export type ExportMarker = Readonly<{
  nodeTag: string;
  songId: string;
  digest: string;
}>;

export function nodeTagOf(nodeKey: string): string {
  return bytesToHex(sha256(utf8ToBytes(nodeKey))).slice(0, NODE_TAG_HEX);
}

export function writeMarker(
  nodeKey: string,
  songId: string,
  digest: string,
): string {
  return [VERSION, nodeTagOf(nodeKey), songId.toLowerCase(), digest].join(';');
}

/** A marker read from a file, or null when it is not one this build knows. */
export function readMarker(raw: string | null | undefined): ExportMarker | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(';');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, nodeTag, songId, digest] = parts;
  if (!NODE_TAG.test(nodeTag) || !SONG_ID.test(songId) || !DIGEST.test(digest)) {
    return null;
  }
  return { nodeTag, songId: songId.toLowerCase(), digest };
}
