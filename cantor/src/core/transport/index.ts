/**
 * The app's view of the shared transport manifest.
 *
 * Every relay, carrier, descriptor, prologue, fragment, and inner constant the
 * app speaks is rendered from `protocol/transport/v1/spec.json` by
 * `node protocol/transport/generate.mjs`. Import numbers and labels from here
 * so a bound can never drift between the app, the node, the relay, and the
 * Android native module. Parsers and state machines stay handwritten.
 */
export * from './generated';
