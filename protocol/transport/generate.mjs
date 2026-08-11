#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_SPEC_PATH = fileURLToPath(new URL('v1/spec.json', import.meta.url));

export const OUTPUT_PATHS = Object.freeze({
  rustProto: 'node/crates/cantor-proto/src/generated/transport.rs',
  rustNode: 'node/crates/cantor-node/src/transport/generated.rs',
  appTypeScript: 'cantor/src/core/transport/generated.ts',
  relayTypeScript: 'relay/src/generated/transport.ts',
  androidKotlin:
    'cantor/android/app/src/main/java/com/cantor/app/transport/GeneratedTransport.kt',
});

const ROOT_KEYS = [
  'schema',
  'contract',
  'release',
  'byte_order',
  'versions',
  'noise',
  'domains',
  'kinds',
  'headers',
  'sizes',
  'bounds',
];

const VERSION_KEYS = [
  'application_current',
  'application_min_supported',
  'application_max_supported',
  'relay',
  'secure_negotiation',
  'transport_descriptor',
  'secure_carrier',
  'secure_record',
  'secure_inner',
];

const NOISE_KEYS = [
  'protocol_name',
  'suite_id',
  'authentication_tag_bytes',
];

const DOMAIN_KEYS = [
  'transport_descriptor_signature',
  'secure_handshake_prologue',
];

const KIND_KEYS = [
  'secure_carrier',
  'fragment_record',
  'control_inner',
  'artifact_chunk_inner',
];

const HEADER_KEYS = [
  'client_carrier_bytes',
  'node_carrier_fixed_bytes',
  'fragment_record_bytes',
  'control_inner_bytes',
  'artifact_inner_fixed_bytes',
];

const SIZE_KEYS = [
  'ed25519_public_key_bytes',
  'ed25519_signature_bytes',
  'x25519_key_bytes',
  'sha256_digest_bytes',
  'channel_nonce_bytes',
];

const BOUND_KEYS = [
  'relay_session_id_utf8_bytes',
  'handshake_message_bytes',
  'noise_plaintext_bytes',
  'secure_ciphertext_bytes',
  'logical_inner_bytes',
  'artifact_chunk_bytes',
  'artifact_identifier_utf8_bytes',
  'artifact_offset_max_safe_integer',
  'session_records_per_direction',
  'session_ciphertext_bytes_per_direction',
];

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function exactObject(value, path, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const actual = Object.keys(value);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
  for (const key of actual) {
    if (!keys.includes(key)) fail(`${path}.${key}`, 'is not allowed');
  }
}

function integer(value, path, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(path, `must be an integer from 1 through ${maximum}`);
  }
}

function text(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(path, 'must be a non-empty string without NUL bytes');
  }
}

function equal(actual, expected, path) {
  if (actual !== expected) fail(path, `must be ${expected}, got ${actual}`);
}

/** Validate without normalizing or mutating the supplied manifest. */
export function validateSpec(spec) {
  exactObject(spec, 'spec', ROOT_KEYS);
  equal(spec.schema, 1, 'spec.schema');
  equal(spec.contract, 'cantor-transport', 'spec.contract');
  integer(spec.release, 'spec.release', 0xffff_ffff);
  equal(spec.byte_order, 'big-endian', 'spec.byte_order');

  exactObject(spec.versions, 'spec.versions', VERSION_KEYS);
  for (const key of VERSION_KEYS) {
    integer(spec.versions[key], `spec.versions.${key}`, 0xff);
  }
  if (
    spec.versions.application_min_supported >
      spec.versions.application_current ||
    spec.versions.application_current >
      spec.versions.application_max_supported
  ) {
    fail(
      'spec.versions',
      'must satisfy min_supported <= current <= max_supported',
    );
  }

  exactObject(spec.noise, 'spec.noise', NOISE_KEYS);
  text(spec.noise.protocol_name, 'spec.noise.protocol_name');
  text(spec.noise.suite_id, 'spec.noise.suite_id');
  integer(
    spec.noise.authentication_tag_bytes,
    'spec.noise.authentication_tag_bytes',
    0xffff,
  );

  exactObject(spec.domains, 'spec.domains', DOMAIN_KEYS);
  for (const key of DOMAIN_KEYS) text(spec.domains[key], `spec.domains.${key}`);

  exactObject(spec.kinds, 'spec.kinds', KIND_KEYS);
  for (const key of KIND_KEYS) {
    integer(spec.kinds[key], `spec.kinds.${key}`, 0xff);
  }
  if (spec.kinds.control_inner === spec.kinds.artifact_chunk_inner) {
    fail('spec.kinds', 'inner kind identifiers must be distinct');
  }

  exactObject(spec.headers, 'spec.headers', HEADER_KEYS);
  for (const key of HEADER_KEYS) {
    integer(spec.headers[key], `spec.headers.${key}`, 0xffff);
  }
  equal(spec.headers.client_carrier_bytes, 1 + 1 + 4, 'spec.headers.client_carrier_bytes');
  equal(
    spec.headers.node_carrier_fixed_bytes,
    1 + 1 + 2 + 4,
    'spec.headers.node_carrier_fixed_bytes',
  );
  equal(
    spec.headers.fragment_record_bytes,
    1 + 1 + 4 + 2 + 2 + 4 + 4,
    'spec.headers.fragment_record_bytes',
  );
  equal(spec.headers.control_inner_bytes, 1 + 1 + 4, 'spec.headers.control_inner_bytes');
  equal(
    spec.headers.artifact_inner_fixed_bytes,
    1 + 1 + 2 + 2 + 8 + 4,
    'spec.headers.artifact_inner_fixed_bytes',
  );

  exactObject(spec.sizes, 'spec.sizes', SIZE_KEYS);
  for (const key of SIZE_KEYS) {
    integer(spec.sizes[key], `spec.sizes.${key}`, 0xffff);
  }

  exactObject(spec.bounds, 'spec.bounds', BOUND_KEYS);
  for (const key of BOUND_KEYS) {
    integer(spec.bounds[key], `spec.bounds.${key}`);
  }
  if (spec.bounds.relay_session_id_utf8_bytes > 0xffff) {
    fail('spec.bounds.relay_session_id_utf8_bytes', 'must fit its u16 field');
  }
  if (spec.bounds.artifact_identifier_utf8_bytes > 0xffff) {
    fail('spec.bounds.artifact_identifier_utf8_bytes', 'must fit its u16 field');
  }
  if (spec.bounds.logical_inner_bytes > 0xffff_ffff) {
    fail('spec.bounds.logical_inner_bytes', 'must fit its u32 field');
  }
  if (spec.bounds.secure_ciphertext_bytes > 0xffff_ffff) {
    fail('spec.bounds.secure_ciphertext_bytes', 'must fit its u32 field');
  }
  if (
    spec.bounds.noise_plaintext_bytes <= spec.headers.fragment_record_bytes
  ) {
    fail(
      'spec.bounds.noise_plaintext_bytes',
      'must exceed the fragment header',
    );
  }
  if (
    spec.bounds.secure_ciphertext_bytes <
    spec.bounds.noise_plaintext_bytes + spec.noise.authentication_tag_bytes
  ) {
    fail(
      'spec.bounds.secure_ciphertext_bytes',
      'must hold a maximum Noise plaintext and authentication tag',
    );
  }
  if (
    spec.bounds.artifact_chunk_bytes +
      spec.headers.artifact_inner_fixed_bytes >=
    spec.bounds.logical_inner_bytes
  ) {
    fail(
      'spec.bounds.artifact_chunk_bytes',
      'must leave room for the artifact header inside a logical message',
    );
  }

  return spec;
}

export function deriveConstants(spec) {
  validateSpec(spec);
  return Object.freeze({
    maxFragmentDataBytes:
      spec.bounds.noise_plaintext_bytes - spec.headers.fragment_record_bytes,
    sha256HexChars: spec.sizes.sha256_digest_bytes * 2,
    expectedPrologueBytes:
      Buffer.byteLength(spec.domains.secure_handshake_prologue, 'utf8') +
      2 +
      1 +
      spec.sizes.ed25519_public_key_bytes +
      spec.sizes.x25519_key_bytes +
      spec.sizes.channel_nonce_bytes,
  });
}

function rustNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

function kotlinNumber(value, suffix = '') {
  return `${rustNumber(value)}${suffix}`;
}

function generatedHeader(comment) {
  return `${comment} @generated by protocol/transport/generate.mjs from protocol/transport/v1/spec.json.\n${comment} DO NOT EDIT; run node protocol/transport/generate.mjs.\n`;
}

function renderRustProto(spec) {
  const v = spec.versions;
  const b = spec.bounds;
  return `${generatedHeader('//')}\n\
pub const APPLICATION_PROTOCOL_VERSION: u8 = ${v.application_current};
pub const APPLICATION_PROTOCOL_MIN_SUPPORTED_VERSION: u8 = ${v.application_min_supported};
pub const APPLICATION_PROTOCOL_MAX_SUPPORTED_VERSION: u8 = ${v.application_max_supported};
pub const ARTIFACT_CHUNK_BYTES: u32 = ${rustNumber(b.artifact_chunk_bytes)};
`;
}

function renderRustNode(spec, derived) {
  const v = spec.versions;
  const n = spec.noise;
  const d = spec.domains;
  const k = spec.kinds;
  const h = spec.headers;
  const s = spec.sizes;
  const b = spec.bounds;
  return `${generatedHeader('//')}\n\
pub(crate) const RELAY_PROTOCOL_VERSION: u8 = ${v.relay};
pub(crate) const SECURE_NEGOTIATION_VERSION: u8 = ${v.secure_negotiation};
pub(crate) const TRANSPORT_DESCRIPTOR_VERSION: u8 = ${v.transport_descriptor};
pub(crate) const SECURE_CARRIER_VERSION: u8 = ${v.secure_carrier};
pub(crate) const SECURE_RECORD_VERSION: u8 = ${v.secure_record};
pub(crate) const SECURE_INNER_VERSION: u8 = ${v.secure_inner};

pub(crate) const NOISE_PROTOCOL_NAME: &str = ${JSON.stringify(n.protocol_name)};
pub(crate) const TRANSPORT_SUITE_ID: &str = ${JSON.stringify(n.suite_id)};
pub(crate) const NOISE_AUTHENTICATION_TAG_BYTES: usize = ${rustNumber(n.authentication_tag_bytes)};

pub(crate) const TRANSPORT_DESCRIPTOR_SIGNATURE_DOMAIN: &[u8] = b${JSON.stringify(d.transport_descriptor_signature)};
pub(crate) const SECURE_HANDSHAKE_PROLOGUE_DOMAIN: &[u8] = b${JSON.stringify(d.secure_handshake_prologue)};

pub(crate) const SECURE_CARRIER_KIND: u8 = ${k.secure_carrier};
pub(crate) const FRAGMENT_RECORD_KIND: u8 = ${k.fragment_record};
pub(crate) const CONTROL_INNER_KIND: u8 = ${k.control_inner};
pub(crate) const ARTIFACT_CHUNK_INNER_KIND: u8 = ${k.artifact_chunk_inner};

pub(crate) const CLIENT_CARRIER_HEADER_BYTES: usize = ${rustNumber(h.client_carrier_bytes)};
pub(crate) const NODE_CARRIER_FIXED_HEADER_BYTES: usize = ${rustNumber(h.node_carrier_fixed_bytes)};
pub(crate) const FRAGMENT_RECORD_HEADER_BYTES: usize = ${rustNumber(h.fragment_record_bytes)};
pub(crate) const CONTROL_INNER_HEADER_BYTES: usize = ${rustNumber(h.control_inner_bytes)};
pub(crate) const ARTIFACT_INNER_FIXED_HEADER_BYTES: usize = ${rustNumber(h.artifact_inner_fixed_bytes)};

pub(crate) const ED25519_PUBLIC_KEY_BYTES: usize = ${rustNumber(s.ed25519_public_key_bytes)};
pub(crate) const ED25519_SIGNATURE_BYTES: usize = ${rustNumber(s.ed25519_signature_bytes)};
pub(crate) const X25519_KEY_BYTES: usize = ${rustNumber(s.x25519_key_bytes)};
pub(crate) const SHA256_DIGEST_BYTES: usize = ${rustNumber(s.sha256_digest_bytes)};
pub(crate) const CHANNEL_NONCE_BYTES: usize = ${rustNumber(s.channel_nonce_bytes)};

pub(crate) const MAX_RELAY_SESSION_ID_UTF8_BYTES: usize = ${rustNumber(b.relay_session_id_utf8_bytes)};
pub(crate) const MAX_HANDSHAKE_MESSAGE_BYTES: usize = ${rustNumber(b.handshake_message_bytes)};
pub(crate) const MAX_NOISE_PLAINTEXT_BYTES: usize = ${rustNumber(b.noise_plaintext_bytes)};
pub(crate) const MAX_SECURE_CIPHERTEXT_BYTES: usize = ${rustNumber(b.secure_ciphertext_bytes)};
pub(crate) const MAX_LOGICAL_INNER_BYTES: usize = ${rustNumber(b.logical_inner_bytes)};
pub(crate) const ARTIFACT_CHUNK_BYTES: usize = ${rustNumber(b.artifact_chunk_bytes)};
pub(crate) const MAX_ARTIFACT_IDENTIFIER_UTF8_BYTES: usize = ${rustNumber(b.artifact_identifier_utf8_bytes)};
pub(crate) const MAX_ARTIFACT_OFFSET_SAFE_INTEGER: u64 = ${rustNumber(b.artifact_offset_max_safe_integer)};
pub(crate) const MAX_SESSION_RECORDS_PER_DIRECTION: u64 = ${rustNumber(b.session_records_per_direction)};
pub(crate) const MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION: u64 = ${rustNumber(b.session_ciphertext_bytes_per_direction)};

pub(crate) const MAX_FRAGMENT_DATA_BYTES: usize = ${rustNumber(derived.maxFragmentDataBytes)};
pub(crate) const SHA256_HEX_CHARS: usize = ${rustNumber(derived.sha256HexChars)};
pub(crate) const EXPECTED_PROLOGUE_BYTES: usize = ${rustNumber(derived.expectedPrologueBytes)};
`;
}

function renderAppTypeScript(spec, derived) {
  const v = spec.versions;
  const n = spec.noise;
  const d = spec.domains;
  const k = spec.kinds;
  const h = spec.headers;
  const s = spec.sizes;
  const b = spec.bounds;
  return `${generatedHeader('//')}\n\
export const APPLICATION_PROTOCOL_VERSION = ${v.application_current} as const;
export const APPLICATION_PROTOCOL_MIN_SUPPORTED_VERSION = ${v.application_min_supported} as const;
export const APPLICATION_PROTOCOL_MAX_SUPPORTED_VERSION = ${v.application_max_supported} as const;
export const RELAY_PROTOCOL_VERSION = ${v.relay} as const;
export const SECURE_NEGOTIATION_VERSION = ${v.secure_negotiation} as const;
export const TRANSPORT_DESCRIPTOR_VERSION = ${v.transport_descriptor} as const;
export const SECURE_CARRIER_VERSION = ${v.secure_carrier} as const;
export const SECURE_RECORD_VERSION = ${v.secure_record} as const;
export const SECURE_INNER_VERSION = ${v.secure_inner} as const;

export const NOISE_PROTOCOL_NAME = ${JSON.stringify(n.protocol_name)} as const;
export const TRANSPORT_SUITE_ID = ${JSON.stringify(n.suite_id)} as const;
export const NOISE_AUTHENTICATION_TAG_BYTES = ${n.authentication_tag_bytes} as const;

export const TRANSPORT_DESCRIPTOR_SIGNATURE_DOMAIN = ${JSON.stringify(d.transport_descriptor_signature)} as const;
export const SECURE_HANDSHAKE_PROLOGUE_DOMAIN = ${JSON.stringify(d.secure_handshake_prologue)} as const;

export const SECURE_CARRIER_KIND = ${k.secure_carrier} as const;
export const FRAGMENT_RECORD_KIND = ${k.fragment_record} as const;
export const CONTROL_INNER_KIND = ${k.control_inner} as const;
export const ARTIFACT_CHUNK_INNER_KIND = ${k.artifact_chunk_inner} as const;

export const CLIENT_CARRIER_HEADER_BYTES = ${h.client_carrier_bytes} as const;
export const NODE_CARRIER_FIXED_HEADER_BYTES = ${h.node_carrier_fixed_bytes} as const;
export const FRAGMENT_RECORD_HEADER_BYTES = ${h.fragment_record_bytes} as const;
export const CONTROL_INNER_HEADER_BYTES = ${h.control_inner_bytes} as const;
export const ARTIFACT_INNER_FIXED_HEADER_BYTES = ${h.artifact_inner_fixed_bytes} as const;

export const ED25519_PUBLIC_KEY_BYTES = ${s.ed25519_public_key_bytes} as const;
export const ED25519_SIGNATURE_BYTES = ${s.ed25519_signature_bytes} as const;
export const X25519_KEY_BYTES = ${s.x25519_key_bytes} as const;
export const SHA256_DIGEST_BYTES = ${s.sha256_digest_bytes} as const;
export const CHANNEL_NONCE_BYTES = ${s.channel_nonce_bytes} as const;

export const MAX_RELAY_SESSION_ID_UTF8_BYTES = ${b.relay_session_id_utf8_bytes} as const;
export const MAX_HANDSHAKE_MESSAGE_BYTES = ${b.handshake_message_bytes} as const;
export const MAX_NOISE_PLAINTEXT_BYTES = ${b.noise_plaintext_bytes} as const;
export const MAX_SECURE_CIPHERTEXT_BYTES = ${b.secure_ciphertext_bytes} as const;
export const MAX_LOGICAL_INNER_BYTES = ${b.logical_inner_bytes} as const;
export const ARTIFACT_CHUNK_BYTES = ${b.artifact_chunk_bytes} as const;
export const MAX_ARTIFACT_IDENTIFIER_UTF8_BYTES = ${b.artifact_identifier_utf8_bytes} as const;
export const MAX_ARTIFACT_OFFSET_SAFE_INTEGER = ${b.artifact_offset_max_safe_integer} as const;
export const MAX_SESSION_RECORDS_PER_DIRECTION = ${b.session_records_per_direction} as const;
export const MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION = ${b.session_ciphertext_bytes_per_direction} as const;

export const MAX_FRAGMENT_DATA_BYTES = ${derived.maxFragmentDataBytes} as const;
export const SHA256_HEX_CHARS = ${derived.sha256HexChars} as const;
export const EXPECTED_PROLOGUE_BYTES = ${derived.expectedPrologueBytes} as const;
`;
}

function renderRelayTypeScript(spec) {
  const v = spec.versions;
  const k = spec.kinds;
  const h = spec.headers;
  const b = spec.bounds;
  return `${generatedHeader('//')}\n\
export const RELAY_PROTOCOL_VERSION = ${v.relay} as const;
export const SECURE_CARRIER_VERSION = ${v.secure_carrier} as const;
export const SECURE_CARRIER_KIND = ${k.secure_carrier} as const;

export const CLIENT_CARRIER_HEADER_BYTES = ${h.client_carrier_bytes} as const;
export const NODE_CARRIER_FIXED_HEADER_BYTES = ${h.node_carrier_fixed_bytes} as const;
export const MAX_RELAY_SESSION_ID_UTF8_BYTES = ${b.relay_session_id_utf8_bytes} as const;
export const MAX_SECURE_CIPHERTEXT_BYTES = ${b.secure_ciphertext_bytes} as const;
`;
}

function renderAndroidKotlin(spec, derived) {
  const v = spec.versions;
  const n = spec.noise;
  const k = spec.kinds;
  const h = spec.headers;
  const b = spec.bounds;
  return `package com.cantor.app.transport

${generatedHeader('//')}\
internal object GeneratedTransport {
  const val SECURE_RECORD_VERSION: Byte = ${v.secure_record}
  const val NOISE_PROTOCOL_NAME: String = ${JSON.stringify(n.protocol_name)}
  const val NOISE_AUTHENTICATION_TAG_BYTES: Int = ${kotlinNumber(n.authentication_tag_bytes)}
  const val FRAGMENT_RECORD_KIND: Byte = ${k.fragment_record}
  const val FRAGMENT_RECORD_HEADER_BYTES: Int = ${kotlinNumber(h.fragment_record_bytes)}
  const val MAX_HANDSHAKE_MESSAGE_BYTES: Int = ${kotlinNumber(b.handshake_message_bytes)}
  const val MAX_NOISE_PLAINTEXT_BYTES: Int = ${kotlinNumber(b.noise_plaintext_bytes)}
  const val MAX_SECURE_CIPHERTEXT_BYTES: Int = ${kotlinNumber(b.secure_ciphertext_bytes)}
  const val MAX_LOGICAL_INNER_BYTES: Int = ${kotlinNumber(b.logical_inner_bytes)}
  const val ARTIFACT_CHUNK_BYTES: Int = ${kotlinNumber(b.artifact_chunk_bytes)}
  const val MAX_SESSION_RECORDS_PER_DIRECTION: Long = ${kotlinNumber(b.session_records_per_direction, 'L')}
  const val MAX_SESSION_CIPHERTEXT_BYTES_PER_DIRECTION: Long = ${kotlinNumber(b.session_ciphertext_bytes_per_direction, 'L')}
  const val MAX_FRAGMENT_DATA_BYTES: Int = ${kotlinNumber(derived.maxFragmentDataBytes)}
  const val EXPECTED_PROLOGUE_BYTES: Int = ${kotlinNumber(derived.expectedPrologueBytes)}
}
`;
}

/** Return all deterministic repository-relative generated outputs. */
export function renderAll(spec) {
  validateSpec(spec);
  const derived = deriveConstants(spec);
  return Object.freeze({
    [OUTPUT_PATHS.rustProto]: renderRustProto(spec),
    [OUTPUT_PATHS.rustNode]: renderRustNode(spec, derived),
    [OUTPUT_PATHS.appTypeScript]: renderAppTypeScript(spec, derived),
    [OUTPUT_PATHS.relayTypeScript]: renderRelayTypeScript(spec),
    [OUTPUT_PATHS.androidKotlin]: renderAndroidKotlin(spec, derived),
  });
}

export async function loadValidate(path = DEFAULT_SPEC_PATH) {
  const source = await readFile(path, 'utf8');
  let spec;
  try {
    spec = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`cannot parse ${path}: ${error.message}`, { cause: error });
  }
  return validateSpec(spec);
}

export async function checkRendered(rendered, root = REPOSITORY_ROOT) {
  const stale = [];
  for (const [relativePath, expected] of Object.entries(rendered)) {
    const target = resolve(root, relativePath);
    let actual;
    try {
      actual = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        stale.push(relativePath);
        continue;
      }
      throw error;
    }
    if (actual !== expected) stale.push(relativePath);
  }
  return stale;
}

export async function writeRendered(rendered, root = REPOSITORY_ROOT) {
  for (const [relativePath, contents] of Object.entries(rendered)) {
    const target = resolve(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    let current;
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === contents) continue;

    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('usage: node protocol/transport/generate.mjs [--check]');
  }
  const spec = await loadValidate();
  const rendered = renderAll(spec);
  if (args[0] === '--check') {
    const stale = await checkRendered(rendered);
    if (stale.length > 0) {
      throw new Error(
        `generated transport constants are stale or missing:\n${stale
          .map(path => `  ${path}`)
          .join('\n')}\nrun: node protocol/transport/generate.mjs`,
      );
    }
    return;
  }
  await writeRendered(rendered);
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
