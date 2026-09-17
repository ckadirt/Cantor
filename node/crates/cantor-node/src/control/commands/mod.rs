use anyhow::Result;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::wire::{CONTROL_VERSION, Request, Response, write_value_line as write_line};
use crate::runtime::{NodeEvent, SharedState};

mod backends;
mod generate;
mod models;
mod pairing;

pub(in crate::control) async fn stream_long_request<W: tokio::io::AsyncWrite + Unpin>(
    line: &str,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    kind: &str,
) -> Result<()> {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return write_line(
                writer,
                &json!({"v": CONTROL_VERSION, "id": "", "t": "error",
                        "code": "invalid-request", "msg": error.to_string()}),
            )
            .await;
        }
    };
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let outcome = match kind {
        "pull" => {
            let selector = request
                .get("selector")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            models::run_pull(&selector, state, events, writer, &id).await
        }
        "generate" => generate::run_generate(&request, state, writer, &id).await,
        "backends" => async {
            if let Some(value) = request.get("keep_loaded").filter(|v| !v.is_null()) {
                let keep = value
                    .as_bool()
                    .ok_or_else(|| anyhow::anyhow!("keep_loaded must be boolean"))?;
                {
                    let mut locked = state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
                    let path = locked.config_path.clone();
                    locked.config.set_keep_loaded(&path, keep)?;
                }
                write_line(writer, &json!({"v": CONTROL_VERSION, "id": id, "t": "note",
                    "msg": format!("keep_loaded={keep}; applies to the next generation (restart to unload an idle session now)")})).await?;
                if request.get("install").and_then(Value::as_bool) != Some(true)
                    && request.get("use").and_then(Value::as_str).is_none()
                {
                    return write_line(writer, &json!({"v": CONTROL_VERSION, "id": id, "t": "ok"}))
                        .await;
                }
            }
            let install = request
                .get("install")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let use_backend = request
                .get("use")
                .and_then(Value::as_str)
                .map(str::to_owned);
            backends::run_backends(state, writer, &id, install, use_backend).await
        }.await,
        _ => models::run_catalog(state, writer, &id).await,
    };

    if let Err(error) = outcome {
        write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "error",
                    "code": "failed", "msg": format!("{error:#}")}),
        )
        .await?;
    }
    Ok(())
}

pub(in crate::control) fn dispatch(
    line: &str,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
) -> Response {
    let fallback_id = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();

    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return Response::error(fallback_id, "invalid-request", error.to_string());
        }
    };

    match handle(request, state, events) {
        Ok(response) => response,
        Err(error) => Response::error(fallback_id, "failed", format!("{error:#}")),
    }
}

fn handle(
    request: Request,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
) -> Result<Response> {
    let mut state = state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;

    match request {
        Request::Status { v, id } => pairing::status(&mut state, v, id),
        Request::Pair { v, id, expires_in } => pairing::pair(&mut state, v, id, expires_in),
        Request::Pairings { v, id } => pairing::pairings(&mut state, v, id),
        Request::Revoke { v, id, selector } => pairing::revoke(&mut state, events, v, id, selector),
        Request::Rename {
            v,
            id,
            selector,
            petname,
        } => pairing::rename(&mut state, v, id, selector, petname),
        Request::List { v, id } => models::list(&mut state, v, id),
        Request::Remove { v, id, selector } => models::remove(&mut state, events, v, id, selector),
        Request::RenameNode { v, id, name } => {
            pairing::rename_node(&mut state, events, v, id, name)
        }
    }
}
