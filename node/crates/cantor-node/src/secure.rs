use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use cantor_proto::{NodeMessage, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState, TransportState, params::NoiseParams};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::config::reject_symlink;
use crate::identity::NodeIdentity;

pub const NOISE_PROTOCOL: &str = "Noise_NK_25519_ChaChaPoly_SHA256";
pub const TRANSPORT_SUITE: &str = "noise-nk-25519-chachapoly-sha256-v1";
pub const SECURE_CHANNEL_VERSION: u8 = 1;
pub const SECURE_CARRIER_VERSION: u8 = 1;
pub const MAX_SECURE_CIPHERTEXT_BYTES: usize = 96 * 1024;

const TRANSPORT_SECRET_BYTES: usize = 32;
const KEY_FILE_MODE: u32 = 0o600;
const CHANNEL_NONCE_BYTES: usize = 32;
const DESCRIPTOR_SIGNATURE_DOMAIN: &[u8] = b"cantor-transport-binding-v1";
const PROLOGUE_DOMAIN: &[u8] = b"cantor-secure-channel-v1";
const MAX_HANDSHAKE_BYTES: usize = 4 * 1024;
const MAX_LOGICAL_INNER_BYTES: usize = 1024 * 1024;
const MAX_NOISE_PLAINTEXT_BYTES: usize = 60 * 1024;
const FRAGMENT_HEADER_BYTES: usize = 18;
const MAX_FRAGMENT_DATA_BYTES: usize = MAX_NOISE_PLAINTEXT_BYTES - FRAGMENT_HEADER_BYTES;
const MAX_SESSION_MESSAGES: u64 = 1_000_000;
const MAX_SESSION_BYTES: u64 = 1024 * 1024 * 1024;
const INNER_CONTROL: u8 = 1;
const INNER_ARTIFACT_CHUNK: u8 = 2;
const RECORD_FRAGMENT: u8 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct TransportDescriptor {
    pub schema: u8,
    pub node_ed25519: String,
    pub transport_suite: String,
    pub transport_key_id: String,
    pub transport_x25519: String,
    pub signature_ed25519: String,
}

pub struct TransportIdentity {
    secret: Zeroizing<[u8; TRANSPORT_SECRET_BYTES]>,
    public: [u8; TRANSPORT_SECRET_BYTES],
    descriptor: TransportDescriptor,
}

impl TransportIdentity {
    pub fn load_or_create(path: &Path, identity: &NodeIdentity) -> Result<(Self, bool)> {
        let (secret, created) = if path.exists() {
            (load_secret(path)?, false)
        } else {
            let mut secret = Zeroizing::new([0_u8; TRANSPORT_SECRET_BYTES]);
            getrandom::fill(&mut secret[..])
                .context("failed to obtain randomness for the transport key")?;
            match create_key_file(path) {
                Ok(mut file) => {
                    file.write_all(&secret[..]).with_context(|| {
                        format!("failed to write transport key {}", path.display())
                    })?;
                    file.sync_all().with_context(|| {
                        format!("failed to sync transport key {}", path.display())
                    })?;
                    (secret, true)
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    (load_secret(path)?, false)
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("failed to create transport key {}", path.display())
                    });
                }
            }
        };
        let static_secret = StaticSecret::from(*secret);
        let public = PublicKey::from(&static_secret).to_bytes();
        let ed25519 = identity.public_key_bytes();
        let key_id = hex_sha256(&public);
        let signature = identity.sign(&descriptor_signature_preimage(&ed25519, &public));
        let descriptor = TransportDescriptor {
            schema: SECURE_CHANNEL_VERSION,
            node_ed25519: identity.public_key_base58(),
            transport_suite: TRANSPORT_SUITE.to_owned(),
            transport_key_id: key_id,
            transport_x25519: URL_SAFE_NO_PAD.encode(public),
            signature_ed25519: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        Ok((
            Self {
                secret,
                public,
                descriptor,
            },
            created,
        ))
    }

    pub fn descriptor(&self) -> &TransportDescriptor {
        &self.descriptor
    }

    pub fn public_key(&self) -> &[u8; TRANSPORT_SECRET_BYTES] {
        &self.public
    }

    fn responder(&self, prologue: &[u8]) -> Result<HandshakeState> {
        let parameters: NoiseParams = NOISE_PROTOCOL
            .parse()
            .expect("the fixed Noise suite is valid");
        Builder::new(parameters)
            .local_private_key(&self.secret[..])?
            .prologue(prologue)?
            .build_responder()
            .context("failed to initialize Noise responder")
    }
}

fn load_secret(path: &Path) -> Result<Zeroizing<[u8; TRANSPORT_SECRET_BYTES]>> {
    reject_symlink(path)?;
    let metadata = fs::metadata(path)
        .with_context(|| format!("failed to inspect transport key {}", path.display()))?;
    ensure!(
        metadata.is_file(),
        "transport key must be a regular file: {}",
        path.display()
    );
    fs::set_permissions(path, fs::Permissions::from_mode(KEY_FILE_MODE))
        .with_context(|| format!("failed to restrict transport key {}", path.display()))?;
    let bytes = Zeroizing::new(
        fs::read(path)
            .with_context(|| format!("failed to read transport key {}", path.display()))?,
    );
    ensure!(
        bytes.len() == TRANSPORT_SECRET_BYTES,
        "transport key {} must contain exactly {TRANSPORT_SECRET_BYTES} bytes",
        path.display()
    );
    let mut secret = Zeroizing::new([0_u8; TRANSPORT_SECRET_BYTES]);
    secret.copy_from_slice(&bytes);
    Ok(secret)
}

fn create_key_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(KEY_FILE_MODE)
        .open(path)
}

pub fn descriptor_signature_preimage(
    node_ed25519: &[u8; 32],
    transport_x25519: &[u8; 32],
) -> Vec<u8> {
    let mut value = Vec::with_capacity(DESCRIPTOR_SIGNATURE_DOMAIN.len() + 64);
    value.extend_from_slice(DESCRIPTOR_SIGNATURE_DOMAIN);
    value.extend_from_slice(node_ed25519);
    value.extend_from_slice(transport_x25519);
    value
}

pub fn handshake_prologue(
    node_ed25519: &[u8; 32],
    transport_x25519: &[u8; 32],
    channel_nonce: &[u8; CHANNEL_NONCE_BYTES],
) -> Vec<u8> {
    let mut value = Vec::with_capacity(PROLOGUE_DOMAIN.len() + 2 + 1 + 32 + 32 + 32);
    value.extend_from_slice(PROLOGUE_DOMAIN);
    value.extend_from_slice(&u16::from(PROTOCOL_VERSION).to_be_bytes());
    value.push(SECURE_CARRIER_VERSION);
    value.extend_from_slice(node_ed25519);
    value.extend_from_slice(transport_x25519);
    value.extend_from_slice(channel_nonce);
    value
}

fn hex_sha256(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Default)]
enum SecureState {
    #[default]
    AwaitingInit,
    Handshake {
        id: String,
        state: Box<HandshakeState>,
    },
    Transport(SecureTransport),
    Failed,
}

#[derive(Default)]
pub struct SecureSession {
    state: SecureState,
}

impl SecureSession {
    pub fn is_ready(&self) -> bool {
        matches!(self.state, SecureState::Transport(_))
    }

    pub fn fail(&mut self) {
        self.state = SecureState::Failed;
    }

    #[cfg(test)]
    pub fn ready_for_test(transport: &TransportIdentity, node_ed25519: &[u8; 32]) -> Result<Self> {
        let nonce = [7_u8; CHANNEL_NONCE_BYTES];
        let prologue = handshake_prologue(node_ed25519, transport.public_key(), &nonce);
        let parameters: NoiseParams = NOISE_PROTOCOL
            .parse()
            .expect("the fixed Noise suite is valid");
        let mut initiator = Builder::new(parameters)
            .remote_public_key(transport.public_key())?
            .prologue(&prologue)?
            .build_initiator()
            .context("failed to create test Noise initiator")?;
        let mut responder = transport.responder(&prologue)?;
        let mut first = [0_u8; MAX_HANDSHAKE_BYTES];
        let first_length = initiator.write_message(&[], &mut first)?;
        let mut empty = [];
        responder.read_message(&first[..first_length], &mut empty)?;
        let mut second = [0_u8; MAX_HANDSHAKE_BYTES];
        let second_length = responder.write_message(&[], &mut second)?;
        initiator.read_message(&second[..second_length], &mut empty)?;
        Ok(Self {
            state: SecureState::Transport(SecureTransport::new(responder.into_transport_mode()?)),
        })
    }

    pub fn handle_text(
        &mut self,
        payload: &Value,
        transport: &TransportIdentity,
        node_ed25519: &[u8; 32],
    ) -> Result<Value> {
        let frame_type = payload.get("t").and_then(Value::as_str);
        if frame_type == Some("secure.init") {
            return self.begin(payload, transport, node_ed25519);
        }
        if frame_type == Some("secure.handshake") {
            return self.finish(payload);
        }
        self.fail();
        Ok(secure_error("secure-required"))
    }

    fn begin(
        &mut self,
        payload: &Value,
        transport: &TransportIdentity,
        node_ed25519: &[u8; 32],
    ) -> Result<Value> {
        ensure!(
            matches!(self.state, SecureState::AwaitingInit),
            "secure session was initialized more than once"
        );
        let id = required_string(payload, "id")?;
        ensure!(
            payload.get("v").and_then(Value::as_u64) == Some(1),
            "invalid secure version"
        );
        ensure!(
            payload.get("suite").and_then(Value::as_str) == Some(TRANSPORT_SUITE),
            "unsupported secure suite"
        );
        let mut nonce = [0_u8; CHANNEL_NONCE_BYTES];
        getrandom::fill(&mut nonce).context("failed to create secure channel nonce")?;
        let prologue = handshake_prologue(node_ed25519, transport.public_key(), &nonce);
        let responder = transport.responder(&prologue)?;
        self.state = SecureState::Handshake {
            id: id.clone(),
            state: Box::new(responder),
        };
        Ok(json!({
            "v": SECURE_CHANNEL_VERSION,
            "t": "secure.offer",
            "id": id,
            "descriptor": transport.descriptor(),
            "channel_nonce": URL_SAFE_NO_PAD.encode(nonce),
        }))
    }

    fn finish(&mut self, payload: &Value) -> Result<Value> {
        let previous = std::mem::replace(&mut self.state, SecureState::Failed);
        let SecureState::Handshake { id, mut state } = previous else {
            bail!("secure handshake arrived in the wrong state");
        };
        ensure!(
            payload.get("v").and_then(Value::as_u64) == Some(1),
            "invalid secure version"
        );
        ensure!(
            payload.get("id").and_then(Value::as_str) == Some(id.as_str()),
            "secure handshake id changed"
        );
        ensure!(
            payload.get("step").and_then(Value::as_u64) == Some(1),
            "invalid secure handshake step"
        );
        let encoded = required_string(payload, "data")?;
        let message = URL_SAFE_NO_PAD
            .decode(encoded)
            .context("secure handshake message is not base64url")?;
        ensure!(
            !message.is_empty() && message.len() <= MAX_HANDSHAKE_BYTES,
            "secure handshake message is outside its bound"
        );
        let mut empty = [0_u8; 0];
        let payload_length = state
            .read_message(&message, &mut empty)
            .context("Noise initiator message failed authentication")?;
        ensure!(payload_length == 0, "Noise handshake payload must be empty");
        let mut response = vec![0_u8; MAX_HANDSHAKE_BYTES];
        let response_length = state
            .write_message(&[], &mut response)
            .context("failed to create Noise responder message")?;
        response.truncate(response_length);
        let transport = (*state)
            .into_transport_mode()
            .context("failed to enter Noise transport mode")?;
        self.state = SecureState::Transport(SecureTransport::new(transport));
        Ok(json!({
            "v": SECURE_CHANNEL_VERSION,
            "t": "secure.handshake",
            "id": id,
            "step": 2,
            "data": URL_SAFE_NO_PAD.encode(response),
        }))
    }

    pub fn decrypt_application(&mut self, ciphertext: &[u8]) -> Result<Option<Value>> {
        let result = match &mut self.state {
            SecureState::Transport(transport) => transport.decrypt_inner(ciphertext),
            _ => bail!("secure transport is not ready"),
        };
        match result {
            Ok(Some(inner)) => decode_client_inner(&inner).map(Some),
            Ok(None) => Ok(None),
            Err(error) => {
                self.fail();
                Err(error)
            }
        }
    }

    pub fn encrypt_application(&mut self, message: &NodeMessage) -> Result<Vec<Vec<u8>>> {
        let inner = encode_node_inner(message)?;
        let result = match &mut self.state {
            SecureState::Transport(transport) => transport.encrypt_inner(&inner),
            _ => bail!("secure transport is not ready"),
        };
        if result.is_err() {
            self.fail();
        }
        result
    }
}

fn secure_error(code: &str) -> Value {
    json!({
        "v": SECURE_CHANNEL_VERSION,
        "t": "secure.error",
        "code": code,
        "message": "A secure channel is required.",
    })
}

fn required_string(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("secure field {field} is invalid"))
}

struct Reassembly {
    message_id: u32,
    fragment_count: u16,
    next_fragment: u16,
    total_length: usize,
    bytes: Vec<u8>,
}

struct SecureTransport {
    state: TransportState,
    send_message_id: u32,
    receive_message_id: u32,
    sent_records: u64,
    received_records: u64,
    sent_bytes: u64,
    received_bytes: u64,
    reassembly: Option<Reassembly>,
}

impl SecureTransport {
    fn new(state: TransportState) -> Self {
        Self {
            state,
            send_message_id: 0,
            receive_message_id: 0,
            sent_records: 0,
            received_records: 0,
            sent_bytes: 0,
            received_bytes: 0,
            reassembly: None,
        }
    }

    fn encrypt_inner(&mut self, inner: &[u8]) -> Result<Vec<Vec<u8>>> {
        ensure!(
            !inner.is_empty() && inner.len() <= MAX_LOGICAL_INNER_BYTES,
            "secure inner message is outside its bound"
        );
        let count = inner.len().div_ceil(MAX_FRAGMENT_DATA_BYTES);
        let count = u16::try_from(count).context("too many secure fragments")?;
        let message_id = self.send_message_id;
        let mut encrypted = Vec::with_capacity(usize::from(count));
        for (index, chunk) in inner.chunks(MAX_FRAGMENT_DATA_BYTES).enumerate() {
            self.check_send_limit(chunk.len() + FRAGMENT_HEADER_BYTES + 16)?;
            let mut record = Vec::with_capacity(FRAGMENT_HEADER_BYTES + chunk.len());
            record.push(SECURE_CHANNEL_VERSION);
            record.push(RECORD_FRAGMENT);
            record.extend_from_slice(&message_id.to_be_bytes());
            record.extend_from_slice(&(index as u16).to_be_bytes());
            record.extend_from_slice(&count.to_be_bytes());
            record.extend_from_slice(&(inner.len() as u32).to_be_bytes());
            record.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
            record.extend_from_slice(chunk);
            let mut ciphertext = vec![0_u8; record.len() + 16];
            let length = self
                .state
                .write_message(&record, &mut ciphertext)
                .context("Noise transport encryption failed")?;
            ciphertext.truncate(length);
            ensure!(
                ciphertext.len() <= MAX_SECURE_CIPHERTEXT_BYTES,
                "Noise ciphertext exceeded the carrier bound"
            );
            self.sent_records += 1;
            self.sent_bytes += ciphertext.len() as u64;
            encrypted.push(ciphertext);
        }
        self.send_message_id = self
            .send_message_id
            .checked_add(1)
            .context("secure send message id exhausted")?;
        Ok(encrypted)
    }

    fn decrypt_inner(&mut self, ciphertext: &[u8]) -> Result<Option<Vec<u8>>> {
        ensure!(
            !ciphertext.is_empty() && ciphertext.len() <= MAX_SECURE_CIPHERTEXT_BYTES,
            "secure ciphertext is outside the carrier bound"
        );
        self.check_receive_limit(ciphertext.len())?;
        let mut plaintext = vec![0_u8; ciphertext.len()];
        let length = self
            .state
            .read_message(ciphertext, &mut plaintext)
            .context("Noise transport authentication failed")?;
        plaintext.truncate(length);
        self.received_records += 1;
        self.received_bytes += ciphertext.len() as u64;
        self.accept_fragment(&plaintext)
    }

    fn accept_fragment(&mut self, record: &[u8]) -> Result<Option<Vec<u8>>> {
        ensure!(
            record.len() >= FRAGMENT_HEADER_BYTES,
            "secure fragment is truncated"
        );
        ensure!(
            record[0] == SECURE_CHANNEL_VERSION && record[1] == RECORD_FRAGMENT,
            "secure fragment header is invalid"
        );
        let message_id = read_u32(record, 2)?;
        let fragment_index = read_u16(record, 6)?;
        let fragment_count = read_u16(record, 8)?;
        let total_length = usize::try_from(read_u32(record, 10)?)?;
        let fragment_length = usize::try_from(read_u32(record, 14)?)?;
        ensure!(
            message_id == self.receive_message_id
                && fragment_count > 0
                && fragment_index < fragment_count
                && total_length > 0
                && total_length <= MAX_LOGICAL_INNER_BYTES
                && fragment_length <= MAX_FRAGMENT_DATA_BYTES
                && record.len() == FRAGMENT_HEADER_BYTES + fragment_length,
            "secure fragment bounds or ordering are invalid"
        );
        if fragment_index == 0 {
            ensure!(self.reassembly.is_none(), "secure messages overlap");
            self.reassembly = Some(Reassembly {
                message_id,
                fragment_count,
                next_fragment: 0,
                total_length,
                bytes: Vec::with_capacity(total_length),
            });
        }
        let assembly = self
            .reassembly
            .as_mut()
            .context("secure fragment did not start at index zero")?;
        ensure!(
            assembly.message_id == message_id
                && assembly.fragment_count == fragment_count
                && assembly.total_length == total_length
                && assembly.next_fragment == fragment_index,
            "secure fragment sequence changed"
        );
        assembly
            .bytes
            .extend_from_slice(&record[FRAGMENT_HEADER_BYTES..]);
        ensure!(
            assembly.bytes.len() <= assembly.total_length,
            "secure fragment exceeds declared length"
        );
        assembly.next_fragment += 1;
        if assembly.next_fragment != assembly.fragment_count {
            return Ok(None);
        }
        let completed = self.reassembly.take().expect("assembly exists");
        ensure!(
            completed.bytes.len() == completed.total_length,
            "secure fragmented message length changed"
        );
        self.receive_message_id = self
            .receive_message_id
            .checked_add(1)
            .context("secure receive message id exhausted")?;
        Ok(Some(completed.bytes))
    }

    fn check_send_limit(&self, next_bytes: usize) -> Result<()> {
        ensure!(
            self.sent_records < MAX_SESSION_MESSAGES
                && self.sent_bytes.saturating_add(next_bytes as u64) <= MAX_SESSION_BYTES,
            "secure send key limit reached; reconnect"
        );
        Ok(())
    }

    fn check_receive_limit(&self, next_bytes: usize) -> Result<()> {
        ensure!(
            self.received_records < MAX_SESSION_MESSAGES
                && self.received_bytes.saturating_add(next_bytes as u64) <= MAX_SESSION_BYTES,
            "secure receive key limit reached; reconnect"
        );
        Ok(())
    }
}

fn encode_node_inner(message: &NodeMessage) -> Result<Vec<u8>> {
    if let NodeMessage::ArtifactChunk {
        id,
        transfer_id,
        offset,
        data,
        ..
    } = message
    {
        let bytes = STANDARD
            .decode(data)
            .context("artifact chunk is not valid base64")?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= 64 * 1024,
            "artifact chunk is outside its bound"
        );
        let id = id.as_bytes();
        let transfer_id = transfer_id.as_bytes();
        let id_length = u16::try_from(id.len()).context("artifact request id is too long")?;
        let transfer_length =
            u16::try_from(transfer_id.len()).context("artifact transfer id is too long")?;
        let mut inner = Vec::with_capacity(18 + id.len() + transfer_id.len() + bytes.len());
        inner.push(SECURE_CHANNEL_VERSION);
        inner.push(INNER_ARTIFACT_CHUNK);
        inner.extend_from_slice(&id_length.to_be_bytes());
        inner.extend_from_slice(id);
        inner.extend_from_slice(&transfer_length.to_be_bytes());
        inner.extend_from_slice(transfer_id);
        inner.extend_from_slice(&offset.to_be_bytes());
        inner.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        inner.extend_from_slice(&bytes);
        return Ok(inner);
    }
    let json = serde_json::to_vec(message).context("failed to encode secure control message")?;
    let mut inner = Vec::with_capacity(6 + json.len());
    inner.push(SECURE_CHANNEL_VERSION);
    inner.push(INNER_CONTROL);
    inner.extend_from_slice(&(json.len() as u32).to_be_bytes());
    inner.extend_from_slice(&json);
    Ok(inner)
}

fn decode_client_inner(inner: &[u8]) -> Result<Value> {
    ensure!(inner.len() >= 6, "secure inner control frame is truncated");
    ensure!(
        inner[0] == SECURE_CHANNEL_VERSION && inner[1] == INNER_CONTROL,
        "client sent an unsupported secure inner frame"
    );
    let length = usize::try_from(read_u32(inner, 2)?)?;
    ensure!(
        inner.len() == 6 + length,
        "secure inner control length changed"
    );
    serde_json::from_slice(&inner[6..]).context("secure inner control is not valid JSON")
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let value: [u8; 2] = bytes
        .get(offset..offset + 2)
        .context("secure integer is truncated")?
        .try_into()
        .expect("slice length checked");
    Ok(u16::from_be_bytes(value))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value: [u8; 4] = bytes
        .get(offset..offset + 4)
        .context("secure integer is truncated")?
        .try_into()
        .expect("slice length checked");
    Ok(u32::from_be_bytes(value))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn transport_key_is_owner_only_stable_and_signed_by_node_identity() {
        let temporary = tempdir().expect("temporary directory");
        let identity_path = temporary.path().join("node.key");
        let transport_path = temporary.path().join("noise.key");
        let (identity, _) = NodeIdentity::load_or_create(&identity_path).expect("node identity");
        let (transport, created) =
            TransportIdentity::load_or_create(&transport_path, &identity).expect("transport key");
        assert!(created);
        assert_eq!(
            fs::metadata(&transport_path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let descriptor = transport.descriptor();
        assert_eq!(descriptor.transport_suite, TRANSPORT_SUITE);
        assert_eq!(
            descriptor.transport_key_id,
            hex_sha256(transport.public_key())
        );
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(&descriptor.signature_ed25519)
                .expect("signature base64"),
        )
        .expect("signature");
        VerifyingKey::from_bytes(&identity.public_key_bytes())
            .expect("verifying key")
            .verify(
                &descriptor_signature_preimage(
                    &identity.public_key_bytes(),
                    transport.public_key(),
                ),
                &signature,
            )
            .expect("descriptor signature");

        let (reloaded, created) =
            TransportIdentity::load_or_create(&transport_path, &identity).expect("reload");
        assert!(!created);
        assert_eq!(reloaded.public_key(), transport.public_key());
    }

    #[test]
    fn noise_transport_fragments_and_rejects_replay_and_cross_session() {
        let temporary = tempdir().expect("temporary directory");
        let (identity, _) = NodeIdentity::load_or_create(&temporary.path().join("node.key"))
            .expect("node identity");
        let (transport, _) =
            TransportIdentity::load_or_create(&temporary.path().join("noise.key"), &identity)
                .expect("transport");
        let nonce = [7_u8; 32];
        let prologue =
            handshake_prologue(&identity.public_key_bytes(), transport.public_key(), &nonce);
        let parameters: NoiseParams = NOISE_PROTOCOL.parse().expect("params");
        let mut initiator = Builder::new(parameters)
            .remote_public_key(transport.public_key())
            .expect("remote key")
            .prologue(&prologue)
            .expect("prologue")
            .build_initiator()
            .expect("initiator");
        let mut responder = transport.responder(&prologue).expect("responder");
        let mut first = [0_u8; 4096];
        let first_len = initiator
            .write_message(&[], &mut first)
            .expect("message one");
        let mut empty = [];
        responder
            .read_message(&first[..first_len], &mut empty)
            .expect("read one");
        let mut second = [0_u8; 4096];
        let second_len = responder
            .write_message(&[], &mut second)
            .expect("message two");
        initiator
            .read_message(&second[..second_len], &mut empty)
            .expect("read two");
        let mut client =
            SecureTransport::new(initiator.into_transport_mode().expect("client transport"));
        let mut node =
            SecureTransport::new(responder.into_transport_mode().expect("node transport"));
        let inner = vec![42_u8; MAX_FRAGMENT_DATA_BYTES + 123];
        let frames = client.encrypt_inner(&inner).expect("encrypt fragmented");
        assert_eq!(frames.len(), 2);
        assert!(node.decrypt_inner(&frames[0]).expect("first").is_none());
        assert_eq!(node.decrypt_inner(&frames[1]).expect("second"), Some(inner));
        assert!(node.decrypt_inner(&frames[1]).is_err(), "replay must fail");

        let other_prologue = handshake_prologue(
            &identity.public_key_bytes(),
            transport.public_key(),
            &[8_u8; 32],
        );
        let other_params: NoiseParams = NOISE_PROTOCOL.parse().expect("params");
        let mut other_initiator = Builder::new(other_params)
            .remote_public_key(transport.public_key())
            .expect("remote key")
            .prologue(&other_prologue)
            .expect("prologue")
            .build_initiator()
            .expect("other initiator");
        let mut other_responder = transport
            .responder(&other_prologue)
            .expect("other responder");
        let first_len = other_initiator
            .write_message(&[], &mut first)
            .expect("other message one");
        other_responder
            .read_message(&first[..first_len], &mut empty)
            .expect("other read one");
        let second_len = other_responder
            .write_message(&[], &mut second)
            .expect("other message two");
        other_initiator
            .read_message(&second[..second_len], &mut empty)
            .expect("other read two");
        let mut other_node = SecureTransport::new(
            other_responder
                .into_transport_mode()
                .expect("other transport"),
        );
        let params: NoiseParams = NOISE_PROTOCOL.parse().expect("params");
        let mut fresh_client = Builder::new(params)
            .remote_public_key(transport.public_key())
            .expect("remote key")
            .prologue(&prologue)
            .expect("prologue")
            .build_initiator()
            .expect("fresh initiator");
        let mut fresh_responder = transport.responder(&prologue).expect("fresh responder");
        let first_len = fresh_client
            .write_message(&[], &mut first)
            .expect("fresh one");
        fresh_responder
            .read_message(&first[..first_len], &mut empty)
            .expect("fresh read one");
        let second_len = fresh_responder
            .write_message(&[], &mut second)
            .expect("fresh two");
        fresh_client
            .read_message(&second[..second_len], &mut empty)
            .expect("fresh read two");
        let mut fresh_client =
            SecureTransport::new(fresh_client.into_transport_mode().expect("fresh transport"));
        let cross = fresh_client.encrypt_inner(&[1, 2, 3]).expect("cross frame");
        assert!(
            other_node.decrypt_inner(&cross[0]).is_err(),
            "session mix-up must fail"
        );
    }
}
