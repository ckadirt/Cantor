use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeLimits {
    pub max_concurrent_jobs: u32,
    pub max_song_seconds: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeLoad {
    pub active_jobs: u32,
    pub queued_jobs: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeInfo {
    pub name: String,
    pub device_type: String,
    pub engine_version: String,
    pub models: Vec<String>,
    pub limits: NodeLimits,
    pub load: NodeLoad,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct JobView {
    pub id: String,
    pub state: String,
    pub stage: String,
    pub step: Option<u32>,
    pub steps_total: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "t")]
#[ts(export)]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    #[ts(rename = "hello")]
    Hello {
        v: u8,
        id: String,
        pubkey: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pair_token: Option<String>,
    },
    #[serde(rename = "auth")]
    #[ts(rename = "auth")]
    Auth { v: u8, id: String, sig: String },
    #[serde(rename = "status")]
    #[ts(rename = "status")]
    Status { v: u8, id: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "t")]
#[ts(export)]
pub enum NodeMessage {
    #[serde(rename = "challenge")]
    #[ts(rename = "challenge")]
    Challenge {
        v: u8,
        id: String,
        nonce: String,
        node_pubkey: String,
    },
    #[serde(rename = "welcome")]
    #[ts(rename = "welcome")]
    Welcome { v: u8, id: String, node: NodeInfo },
    #[serde(rename = "jobs")]
    #[ts(rename = "jobs")]
    Jobs {
        v: u8,
        id: String,
        jobs: Vec<JobView>,
    },
    #[serde(rename = "error")]
    #[ts(rename = "error")]
    Error {
        v: u8,
        id: String,
        code: String,
        msg: String,
    },
}

impl NodeMessage {
    pub fn error(id: impl Into<String>, code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self::Error {
            v: PROTOCOL_VERSION,
            id: id.into(),
            code: code.into(),
            msg: msg.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ClientMessage, PROTOCOL_VERSION};

    #[test]
    fn hello_uses_the_flat_versioned_wire_shape() {
        let message = ClientMessage::Hello {
            v: PROTOCOL_VERSION,
            id: "request-1".to_owned(),
            pubkey: "client-key".to_owned(),
            pair_token: None,
        };

        assert_eq!(
            serde_json::to_value(message).expect("serialize hello"),
            serde_json::json!({
                "t": "hello",
                "v": 1,
                "id": "request-1",
                "pubkey": "client-key"
            })
        );
    }
}
