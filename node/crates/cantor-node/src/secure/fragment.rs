//! Exact secure fragment record framing and in-order reassembly.
//!
//! Nothing here knows about Noise. A record is the plaintext the cipher state
//! protects: one header plus one slice of a logical inner message. Keeping the
//! codec pure means ordering, overlap, and bound rules can be read and tested
//! without a handshake.

use anyhow::{Context, Result, ensure};

use crate::transport::{
    FRAGMENT_RECORD_HEADER_BYTES, FRAGMENT_RECORD_KIND, MAX_FRAGMENT_DATA_BYTES,
    MAX_LOGICAL_INNER_BYTES, SECURE_RECORD_VERSION,
};

/// How many fragments a logical inner message of `length` bytes occupies.
pub(super) fn fragment_count(length: usize) -> Result<u16> {
    ensure!(
        length > 0 && length <= MAX_LOGICAL_INNER_BYTES,
        "secure inner message is outside its bound"
    );
    u16::try_from(length.div_ceil(MAX_FRAGMENT_DATA_BYTES)).context("too many secure fragments")
}

pub(super) fn encode_fragment_record(
    message_id: u32,
    index: u16,
    count: u16,
    total_length: usize,
    data: &[u8],
) -> Vec<u8> {
    let mut record = Vec::with_capacity(FRAGMENT_RECORD_HEADER_BYTES + data.len());
    record.push(SECURE_RECORD_VERSION);
    record.push(FRAGMENT_RECORD_KIND);
    record.extend_from_slice(&message_id.to_be_bytes());
    record.extend_from_slice(&index.to_be_bytes());
    record.extend_from_slice(&count.to_be_bytes());
    record.extend_from_slice(&(total_length as u32).to_be_bytes());
    record.extend_from_slice(&(data.len() as u32).to_be_bytes());
    record.extend_from_slice(data);
    record
}

pub(super) struct FragmentRecord<'a> {
    message_id: u32,
    index: u16,
    count: u16,
    total_length: usize,
    data: &'a [u8],
}

/// Validate one record's own structure. Sequence position is the reassembler's
/// decision, not this function's.
pub(super) fn parse_fragment_record(record: &[u8]) -> Result<FragmentRecord<'_>> {
    ensure!(
        record.len() >= FRAGMENT_RECORD_HEADER_BYTES,
        "secure fragment is truncated"
    );
    ensure!(
        record[0] == SECURE_RECORD_VERSION && record[1] == FRAGMENT_RECORD_KIND,
        "secure fragment header is invalid"
    );
    let message_id = read_u32(record, 2)?;
    let index = read_u16(record, 6)?;
    let count = read_u16(record, 8)?;
    let total_length = usize::try_from(read_u32(record, 10)?)?;
    let data_length = usize::try_from(read_u32(record, 14)?)?;
    ensure!(
        count > 0
            && index < count
            && total_length > 0
            && total_length <= MAX_LOGICAL_INNER_BYTES
            && data_length <= MAX_FRAGMENT_DATA_BYTES
            && record.len() == FRAGMENT_RECORD_HEADER_BYTES + data_length,
        "secure fragment bounds or ordering are invalid"
    );
    Ok(FragmentRecord {
        message_id,
        index,
        count,
        total_length,
        data: &record[FRAGMENT_RECORD_HEADER_BYTES..],
    })
}

struct Assembly {
    message_id: u32,
    count: u16,
    next_index: u16,
    total_length: usize,
    bytes: Vec<u8>,
}

/// Accepts fragments for exactly one message at a time, in order, starting at
/// the message id that follows the last completed one.
#[derive(Default)]
pub(super) struct Reassembler {
    expected_message_id: u32,
    assembly: Option<Assembly>,
}

impl Reassembler {
    /// Returns the completed inner message, or `None` while fragments remain.
    pub(super) fn accept(&mut self, record: &[u8]) -> Result<Option<Vec<u8>>> {
        let fragment = parse_fragment_record(record)?;
        ensure!(
            fragment.message_id == self.expected_message_id,
            "secure fragment bounds or ordering are invalid"
        );
        if fragment.index == 0 {
            ensure!(self.assembly.is_none(), "secure messages overlap");
            self.assembly = Some(Assembly {
                message_id: fragment.message_id,
                count: fragment.count,
                next_index: 0,
                total_length: fragment.total_length,
                bytes: Vec::with_capacity(fragment.total_length),
            });
        }
        let assembly = self
            .assembly
            .as_mut()
            .context("secure fragment did not start at index zero")?;
        ensure!(
            assembly.message_id == fragment.message_id
                && assembly.count == fragment.count
                && assembly.total_length == fragment.total_length
                && assembly.next_index == fragment.index,
            "secure fragment sequence changed"
        );
        assembly.bytes.extend_from_slice(fragment.data);
        ensure!(
            assembly.bytes.len() <= assembly.total_length,
            "secure fragment exceeds declared length"
        );
        assembly.next_index += 1;
        if assembly.next_index != assembly.count {
            return Ok(None);
        }
        let completed = self.assembly.take().expect("assembly exists");
        ensure!(
            completed.bytes.len() == completed.total_length,
            "secure fragmented message length changed"
        );
        self.expected_message_id = self
            .expected_message_id
            .checked_add(1)
            .context("secure receive message id exhausted")?;
        Ok(Some(completed.bytes))
    }
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
    use serde_json::Value;

    use super::{Reassembler, encode_fragment_record, fragment_count};
    use crate::transport::{MAX_FRAGMENT_DATA_BYTES, MAX_LOGICAL_INNER_BYTES};

    const FRAGMENT_FIXTURE: &str =
        include_str!("../../../../../protocol/transport/v1/fixtures/fragment.json");

    #[test]
    fn shared_fragment_fixture_records_current_rust_acceptance_exactly() {
        let fixture: Value = serde_json::from_str(FRAGMENT_FIXTURE).expect("fragment fixture");
        let valid = &fixture["valid"]["single_control"];
        assert_eq!(
            Reassembler::default()
                .accept(&fixture_hex(&valid["record_hex"]))
                .expect("valid fragment"),
            Some(fixture_hex(&valid["inner_hex"]))
        );

        for malformed in fixture["malformed"]
            .as_array()
            .expect("malformed fragment fixtures")
        {
            let result = Reassembler::default().accept(&fixture_hex(&malformed["record_hex"]));
            match malformed["rust"].as_str().expect("Rust expectation") {
                "reject" => assert!(result.is_err(), "fixture {} must fail", malformed["id"]),
                "accept_partial" => assert_eq!(
                    result.expect("accepted partial fragment"),
                    None,
                    "fixture {}",
                    malformed["id"]
                ),
                expectation => panic!("unknown Rust fixture expectation {expectation}"),
            }
        }
    }

    #[test]
    fn fragment_counts_cover_the_exact_single_and_multi_record_boundary() {
        assert!(fragment_count(0).is_err());
        assert!(fragment_count(MAX_LOGICAL_INNER_BYTES + 1).is_err());
        assert_eq!(fragment_count(1).expect("one byte"), 1);
        assert_eq!(
            fragment_count(MAX_FRAGMENT_DATA_BYTES).expect("exact fragment"),
            1
        );
        assert_eq!(
            fragment_count(MAX_FRAGMENT_DATA_BYTES + 1).expect("one byte over"),
            2
        );
    }

    #[test]
    fn reassembly_requires_ordered_fragments_of_one_message_at_a_time() {
        let inner = vec![9_u8; MAX_FRAGMENT_DATA_BYTES + 5];
        let count = fragment_count(inner.len()).expect("two fragments");
        assert_eq!(count, 2);
        let records: Vec<Vec<u8>> = inner
            .chunks(MAX_FRAGMENT_DATA_BYTES)
            .enumerate()
            .map(|(index, chunk)| {
                encode_fragment_record(0, index as u16, count, inner.len(), chunk)
            })
            .collect();

        let mut reassembler = Reassembler::default();
        assert_eq!(reassembler.accept(&records[0]).expect("first"), None);
        assert_eq!(
            reassembler.accept(&records[1]).expect("second"),
            Some(inner.clone())
        );

        // A second message must use the next message id, in order, from zero.
        let mut reassembler = Reassembler::default();
        assert!(reassembler.accept(&records[1]).is_err());

        let mut reassembler = Reassembler::default();
        assert_eq!(reassembler.accept(&records[0]).expect("first"), None);
        assert!(
            reassembler.accept(&records[0]).is_err(),
            "a repeated opening fragment overlaps the message being assembled"
        );

        let mut reassembler = Reassembler::default();
        assert_eq!(reassembler.accept(&records[0]).expect("first"), None);
        assert_eq!(
            reassembler.accept(&records[1]).expect("second"),
            Some(inner)
        );
        assert!(
            reassembler.accept(&records[0]).is_err(),
            "the completed message id is not replayable"
        );
    }

    fn fixture_hex(value: &Value) -> Vec<u8> {
        let value = value.as_str().expect("fixture hex string");
        assert!(value.len().is_multiple_of(2), "fixture hex length");
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("fixture hex UTF-8");
                u8::from_str_radix(pair, 16).expect("fixture canonical hex")
            })
            .collect()
    }
}
