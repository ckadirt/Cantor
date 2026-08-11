//! Stable application error response constructors.

use cantor_proto::{ErrorCode, ErrorDetails, NodeMessage, PROTOCOL_VERSION};

pub(super) fn song_not_found(id: String) -> NodeMessage {
    NodeMessage::error(
        Some(id),
        ErrorCode::NotFound,
        "That song was not found.",
        false,
    )
}

pub(super) fn unauthenticated(id: String, resource: &str) -> NodeMessage {
    NodeMessage::error(
        Some(id),
        ErrorCode::Unauthenticated,
        format!("Authenticate before requesting {resource}."),
        false,
    )
}

pub(super) fn invalid_field(id: String, field: &str) -> NodeMessage {
    NodeMessage::Error {
        v: PROTOCOL_VERSION,
        id: Some(id),
        code: ErrorCode::InvalidRequest,
        message: format!("The {field} field is invalid."),
        retryable: false,
        details: Some(ErrorDetails::InvalidField {
            field: field.to_owned(),
        }),
    }
}

pub(super) fn unsupported_version(id: String) -> NodeMessage {
    NodeMessage::unsupported_version(Some(id))
}
