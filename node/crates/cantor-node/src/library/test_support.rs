//! Test-only fixtures that need controlled access to the concrete library.

use sha2::Digest;

use crate::principal::PrincipalId;

use super::Library;

impl Library {
    pub(crate) fn seed_delivery_fixture_for_test(&self, key: [u8; 32]) -> (String, String) {
        let principal = PrincipalId::from_client_public_key(&key).to_string();
        let song_id = uuid::Uuid::new_v4().to_string();
        let mut bytes = vec![0_u8; 100];
        bytes[..4].copy_from_slice(b"OggS");
        let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
        let artifact_directory = self
            .root
            .join("jobs")
            .join(&principal)
            .join(&song_id)
            .join("artifacts");
        std::fs::create_dir_all(&artifact_directory).unwrap();
        std::fs::write(artifact_directory.join("delivery.opus"), bytes).unwrap();
        self.connection
            .execute(
                "INSERT INTO principals(id,kind,public_key,created_at) VALUES(?1,'app',?2,?3)",
                rusqlite::params![
                    principal,
                    bs58::encode(key).into_string(),
                    "2026-08-09T00:00:00Z"
                ],
            )
            .unwrap();
        self.connection
            .execute(
                "INSERT INTO jobs(id,principal_id,client_request_id,request_hash,model_selector,
                 request_json,state,revision,created_at,updated_at)
                 VALUES(?1,?2,'request','hash','model','{}','completed',1,?3,?3)",
                rusqlite::params![song_id, principal, "2026-08-09T00:00:00Z"],
            )
            .unwrap();
        self.connection
            .execute(
                "INSERT INTO songs(id,principal_id,title,caption_summary,created_at,duration_ms,
                 model_selector,published_revision,changed_revision)
                 VALUES(?1,?2,'song','song',?3,1000,'model',1,1)",
                rusqlite::params![song_id, principal, "2026-08-09T00:00:00Z"],
            )
            .unwrap();
        self.connection
            .execute(
                "INSERT INTO artifacts(job_id,kind,profile,relative_path,media_type,byte_length,
                 sha256,sample_rate,channels,duration_ms,created_at)
                 VALUES(?1,'delivery','opus-stereo-160k-v1','artifacts/delivery.opus',
                 'audio/ogg; codecs=opus',100,?2,48000,2,1000,?3)",
                rusqlite::params![song_id, digest, "2026-08-09T00:00:00Z"],
            )
            .unwrap();
        (song_id, digest)
    }
}
