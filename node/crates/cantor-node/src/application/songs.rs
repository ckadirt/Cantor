//! Principal-scoped private-library reads, synchronization, and song mutations.

use anyhow::Result;
use cantor_proto::{
    DEFAULT_PAGE_LIMIT, ErrorCode, ErrorDetails, MAX_PAGE_LIMIT, NodeMessage, PROTOCOL_VERSION,
    SongPatch,
};

use crate::library::{ChangePageResult, Library, MutationResult, PresenceMutation, SongPageResult};

use super::auth::AuthenticatedSession;
use super::errors::{invalid_field, song_not_found, unauthenticated};

#[allow(clippy::too_many_arguments)]
pub(super) fn list(
    version: u8,
    id: String,
    limit: Option<u32>,
    cursor: Option<String>,
    include_trashed: bool,
    authentication: Option<&AuthenticatedSession>,
    library: &Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "library"));
    };
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT);
    if limit == 0 || limit > MAX_PAGE_LIMIT {
        return Ok(invalid_field(id, "limit"));
    }
    match library.list_songs(
        context.principal_id,
        limit,
        cursor.as_deref(),
        include_trashed,
    )? {
        SongPageResult::Page(page) => Ok(NodeMessage::LibraryPage {
            v: PROTOCOL_VERSION,
            id,
            snapshot_revision: page.snapshot_revision,
            songs: page.songs,
            tombstones: Vec::new(),
            next_cursor: page.next_cursor,
        }),
        SongPageResult::InvalidCursor => Ok(invalid_field(id, "cursor")),
    }
}

pub(super) fn sync(
    version: u8,
    id: String,
    since_revision: u64,
    limit: Option<u32>,
    authentication: Option<&AuthenticatedSession>,
    library: &Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "library"));
    };
    let limit = limit.unwrap_or(MAX_PAGE_LIMIT);
    if limit == 0 || limit > MAX_PAGE_LIMIT {
        return Ok(invalid_field(id, "limit"));
    }
    match library.sync_songs(context.principal_id, since_revision, limit)? {
        ChangePageResult::Page(page) => Ok(NodeMessage::LibraryChanges {
            v: PROTOCOL_VERSION,
            id,
            through_revision: page.through_revision,
            changes: page.changes,
            has_more: page.has_more,
        }),
        ChangePageResult::FullSyncRequired { minimum_revision } => Ok(NodeMessage::Error {
            v: PROTOCOL_VERSION,
            id: Some(id),
            code: ErrorCode::FullSyncRequired,
            message: "A fresh private-library snapshot is required.".into(),
            retryable: true,
            details: Some(ErrorDetails::FullSync { minimum_revision }),
        }),
        ChangePageResult::InvalidRevision => Ok(invalid_field(id, "since_revision")),
    }
}

pub(super) fn get(
    version: u8,
    id: String,
    song_id: String,
    authentication: Option<&AuthenticatedSession>,
    library: &Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "songs"));
    };
    match library.song_detail(context.principal_id, &song_id)? {
        Some(detail) => Ok(NodeMessage::SongDetail {
            v: PROTOCOL_VERSION,
            id,
            detail,
        }),
        None => Ok(song_not_found(id)),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn patch(
    version: u8,
    id: String,
    song_id: String,
    expected_revision: u32,
    patch: SongPatch,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "songs"));
    };
    mutation_message(
        id,
        library.patch_song(context.principal_id, &song_id, expected_revision, &patch)?,
    )
}

pub(super) fn trash(
    version: u8,
    id: String,
    song_id: String,
    expected_revision: u32,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    change_presence(
        version,
        id,
        song_id,
        expected_revision,
        PresenceMutation::Trash,
        authentication,
        library,
    )
}

pub(super) fn restore(
    version: u8,
    id: String,
    song_id: String,
    expected_revision: u32,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    change_presence(
        version,
        id,
        song_id,
        expected_revision,
        PresenceMutation::Restore,
        authentication,
        library,
    )
}

#[allow(clippy::too_many_arguments)]
fn change_presence(
    version: u8,
    id: String,
    song_id: String,
    expected_revision: u32,
    mutation: PresenceMutation,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "songs"));
    };
    mutation_message(
        id,
        library.change_song_presence(
            context.principal_id,
            &song_id,
            expected_revision,
            mutation,
        )?,
    )
}

fn mutation_message(id: String, result: MutationResult) -> Result<NodeMessage> {
    Ok(match result {
        MutationResult::Updated(song) => NodeMessage::SongUpdated {
            v: PROTOCOL_VERSION,
            id,
            song,
        },
        MutationResult::Conflict(current) => NodeMessage::Error {
            v: PROTOCOL_VERSION,
            id: Some(id),
            code: ErrorCode::RevisionConflict,
            message: "The song changed on another device.".into(),
            retryable: false,
            details: Some(ErrorDetails::RevisionConflict { current }),
        },
        MutationResult::NotFound => song_not_found(id),
        MutationResult::InvalidPatch => invalid_field(id, "patch"),
    })
}

#[cfg(test)]
mod tests {
    use cantor_proto::{
        ErrorCode, GenerationRequest, GenerationStage, NodeMessage, PROTOCOL_VERSION, ProgressUnit,
        SongPatch,
    };
    use tempfile::tempdir;
    use uuid::Uuid;

    use crate::catalog::Component;
    use crate::library::{Library, Submission, SubmitResult};
    use crate::principal::PrincipalId;
    use crate::runtime::NodeEvent;
    use crate::store::InstalledVariant;

    use super::super::outcome::{ApplicationEffect, from_response};
    use super::{AuthenticatedSession, patch};

    fn variant() -> InstalledVariant {
        InstalledVariant {
            model: "acestep".into(),
            tag: "1.5-fast".into(),
            licence: String::new(),
            components: vec![Component {
                role: "model".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "https://example.invalid/model".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
            stages: Vec::new(),
            parameters: Vec::new(),
            lyrics: None,
        }
    }

    fn published_song() -> (
        tempfile::TempDir,
        Library,
        AuthenticatedSession,
        String,
        u32,
    ) {
        let temporary = tempdir().expect("temporary directory");
        let key = [7_u8; 32];
        let principal_id = PrincipalId::from_client_public_key(&key);
        let authentication = AuthenticatedSession {
            relay_session_id: "session".into(),
            principal_id,
            client_public_key: key,
        };
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let submission = Submission {
            client_request_id: Uuid::new_v4().to_string(),
            model: "acestep:1.5-fast".into(),
            generation: GenerationRequest {
                caption: "Original title".into(),
                lyrics: None,
                duration: Some(60),
                steps: None,
                cfg: None,
                seed: Some(7),
                extensions: None,
            },
        };
        let accepted = match library
            .submit(principal_id, &key, &submission, &variant(), 20, 0)
            .expect("submission")
        {
            SubmitResult::Accepted(job) => job,
            other => panic!("unexpected submission: {other:?}"),
        };
        let (work, _) = library.claim_next().expect("claim").expect("queued job");
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .expect("progress");
        library
            .begin_finalizing(&work)
            .expect("begin finalizing")
            .expect("current claim");
        let (_, _, song, committed_revision) = library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0, 0.5, -0.5, 0.0],
                    sample_rate: 1_000,
                },
            )
            .expect("complete")
            .expect("current claim");
        assert_eq!(song.id, accepted.id);
        assert_eq!(committed_revision, 1);
        (temporary, library, authentication, song.id, song.revision)
    }

    fn outcome(
        response: NodeMessage,
        authentication: &AuthenticatedSession,
        library: &Library,
    ) -> super::super::outcome::ApplicationOutcome {
        let revision = library
            .library_revision(authentication.principal_id)
            .expect("library revision");
        from_response(response, Some(authentication.principal_id), Some(revision))
    }

    #[test]
    fn successful_mutations_publish_the_exact_committed_library_revision() {
        let (_temporary, mut library, authentication, song_id, song_revision) = published_song();
        let response = patch(
            PROTOCOL_VERSION,
            "patch".into(),
            song_id,
            song_revision,
            SongPatch {
                title: Some("After Midnight".into()),
                favorite: Some(true),
                tags: Some(vec!["bolero".into()]),
            },
            Some(&authentication),
            &mut library,
        )
        .expect("patch");
        let outcome = outcome(response, &authentication, &library);

        assert!(matches!(
            outcome.response,
            NodeMessage::SongUpdated { ref song, .. }
                if song.title == "After Midnight" && song.revision == song_revision + 1
        ));
        match outcome.effects.as_slice() {
            [
                ApplicationEffect::Publish(NodeEvent::LibraryChanged {
                    principal_id,
                    revision,
                }),
            ] => {
                assert_eq!(*principal_id, authentication.principal_id);
                assert_eq!(*revision, 2);
            }
            other => panic!("unexpected effects: {other:?}"),
        }
    }

    #[test]
    fn conflict_invalid_patch_and_foreign_song_failures_have_no_effects() {
        let (_temporary, mut library, authentication, song_id, song_revision) = published_song();

        let updated = patch(
            PROTOCOL_VERSION,
            "first".into(),
            song_id.clone(),
            song_revision,
            SongPatch {
                title: Some("Updated".into()),
                ..SongPatch::default()
            },
            Some(&authentication),
            &mut library,
        )
        .expect("first patch");
        assert!(matches!(updated, NodeMessage::SongUpdated { .. }));

        let conflict = patch(
            PROTOCOL_VERSION,
            "conflict".into(),
            song_id.clone(),
            song_revision,
            SongPatch {
                title: Some("Stale".into()),
                ..SongPatch::default()
            },
            Some(&authentication),
            &mut library,
        )
        .expect("conflicting patch");
        let conflict = outcome(conflict, &authentication, &library);
        assert!(conflict.effects.is_empty());
        assert!(matches!(
            conflict.response,
            NodeMessage::Error {
                code: ErrorCode::RevisionConflict,
                ..
            }
        ));

        let invalid = patch(
            PROTOCOL_VERSION,
            "invalid".into(),
            song_id.clone(),
            song_revision + 1,
            SongPatch::default(),
            Some(&authentication),
            &mut library,
        )
        .expect("invalid patch");
        let invalid = outcome(invalid, &authentication, &library);
        assert!(invalid.effects.is_empty());
        assert!(matches!(
            invalid.response,
            NodeMessage::Error {
                code: ErrorCode::InvalidRequest,
                ..
            }
        ));

        let foreign_key = [9_u8; 32];
        let foreign = AuthenticatedSession {
            relay_session_id: "foreign".into(),
            principal_id: PrincipalId::from_client_public_key(&foreign_key),
            client_public_key: foreign_key,
        };
        let missing = patch(
            PROTOCOL_VERSION,
            "foreign".into(),
            song_id,
            song_revision + 1,
            SongPatch {
                favorite: Some(true),
                ..SongPatch::default()
            },
            Some(&foreign),
            &mut library,
        )
        .expect("foreign patch");
        let missing = outcome(missing, &foreign, &library);
        assert!(missing.effects.is_empty());
        assert!(matches!(
            missing.response,
            NodeMessage::Error {
                code: ErrorCode::NotFound,
                ..
            }
        ));
    }
}
