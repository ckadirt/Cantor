//! Typed owner identity used by durable jobs, songs, transfers, and events.
//!
//! A client principal is the SHA-256 digest of the canonical 32-byte Ed25519
//! public key. The tuple field is private and there is deliberately no generic
//! `From<[u8; 32]>`: callers must either derive an identity from a client key or
//! parse the canonical representation read from durable storage.

use std::fmt;
use std::str::FromStr;

use sha2::{Digest, Sha256};

const PRINCIPAL_BYTES: usize = 32;
const PRINCIPAL_HEX_BYTES: usize = PRINCIPAL_BYTES * 2;
const LOCAL_OPERATOR_DOMAIN: &[u8] = b"cantor-local-operator-v1";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PrincipalId([u8; PRINCIPAL_BYTES]);

impl PrincipalId {
    pub fn from_client_public_key(public_key: &[u8; PRINCIPAL_BYTES]) -> Self {
        Self(Sha256::digest(public_key).into())
    }

    pub fn as_bytes(&self) -> &[u8; PRINCIPAL_BYTES] {
        &self.0
    }

    /// The CLI is an owner in the same durable tables, but intentionally has no
    /// client key. Keep that exceptional derivation named and domain-separated.
    pub(crate) fn local_operator() -> Self {
        Self(Sha256::digest(LOCAL_OPERATOR_DOMAIN).into())
    }

    #[cfg(test)]
    pub(crate) const fn from_bytes_for_test(bytes: [u8; PRINCIPAL_BYTES]) -> Self {
        Self(bytes)
    }
}

impl fmt::Display for PrincipalId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in *self.as_bytes() {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParsePrincipalIdError;

impl fmt::Display for ParsePrincipalIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("principal ID is not canonical hex")
    }
}

impl std::error::Error for ParsePrincipalIdError {}

impl FromStr for PrincipalId {
    type Err = ParsePrincipalIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != PRINCIPAL_HEX_BYTES
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ParsePrincipalIdError);
        }
        let mut bytes = [0_u8; PRINCIPAL_BYTES];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| ParsePrincipalIdError)?;
        }
        Ok(Self(bytes))
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::PrincipalId;

    #[test]
    fn client_public_key_derivation_is_byte_exact_and_canonical() {
        let principal = PrincipalId::from_client_public_key(&[1_u8; 32]);
        assert_eq!(
            principal.as_bytes(),
            &[
                0x72, 0xcd, 0x6e, 0x84, 0x22, 0xc4, 0x07, 0xfb, 0x6d, 0x09, 0x86, 0x90, 0xf1, 0x13,
                0x0b, 0x7d, 0xed, 0x7e, 0xc2, 0xf7, 0xf5, 0xe1, 0xd3, 0x0b, 0xd9, 0xd5, 0x21, 0xf0,
                0x15, 0x36, 0x37, 0x93,
            ]
        );
        assert_eq!(
            principal.to_string(),
            "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793"
        );
        assert_eq!(
            PrincipalId::from_str(&principal.to_string()).unwrap(),
            principal
        );
    }

    #[test]
    fn parser_rejects_every_noncanonical_shape() {
        let canonical = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";
        for invalid in [
            &canonical[..63],
            &format!("{canonical}0"),
            &canonical.to_uppercase(),
            &format!("g{}", &canonical[1..]),
            &format!(" {}", &canonical[..63]),
        ] {
            assert!(
                PrincipalId::from_str(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn local_operator_is_stable_and_distinct_from_a_client_key() {
        let local = PrincipalId::local_operator();
        assert_eq!(
            local.to_string(),
            "697a5f1a7500a58dd6766e3950bad667477d7033ed869bcfa975509d57044a9c"
        );
        assert_ne!(local, PrincipalId::from_client_public_key(&[0_u8; 32]));
    }
}
