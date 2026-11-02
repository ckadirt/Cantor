//! `cantor queue`: asks the daemon, renders for a person.

use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::control;

/// Ids per `queue-cancel` request, well inside the control request limit.
const CANCEL_BATCH: usize = 500;
/// Past this a bulk cancel reports its tally, not every job.
const LISTED_OUTCOMES: usize = 20;
const CAPTION_WIDTH: usize = 48;

pub struct Options {
    /// The subcommand, then its jobs.
    pub positional: Vec<String>,
    pub all: bool,
    pub json: bool,
    pub yes: bool,
    pub from: Option<String>,
    pub model: Option<String>,
}

pub async fn run(socket: &Path, options: Options) -> Result<()> {
    let (action, jobs) = match options.positional.split_first() {
        Some((action, jobs)) => (Some(action.as_str()), jobs),
        None => (None, &[][..]),
    };
    match action {
        None => {
            let jobs = fetch(socket, &json!({})).await?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&jobs)?);
            } else {
                print!("{}", render(&jobs, OffsetDateTime::now_utc()));
            }
            Ok(())
        }
        Some("show") => {
            if jobs.is_empty() {
                bail!("queue show needs a job, like `cantor queue show 3f2a91c0`");
            }
            let found = fetch(socket, &json!({"jobs": jobs})).await?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&found)?);
            } else {
                for job in &found {
                    print!("{}", render_one(job));
                }
            }
            Ok(())
        }
        Some("cancel") => cancel(socket, jobs, &options).await,
        Some(other) => bail!("queue has no command {other}; see `cantor --help`"),
    }
}

/// Select first, then confirm, then cancel exactly the ids that were confirmed:
/// a job arriving at the prompt is not one you agreed to lose.
async fn cancel(socket: &Path, jobs: &[String], options: &Options) -> Result<()> {
    let filtered = options.all || options.from.is_some() || options.model.is_some();
    if jobs.is_empty() && !filtered {
        bail!("queue cancel needs jobs, or --all, --from or --model");
    }
    let selector = json!({"jobs": jobs, "all": options.all,
                          "from": options.from, "model": options.model});
    let chosen = fetch(socket, &selector).await?;
    if chosen.is_empty() {
        println!("nothing to cancel");
        return Ok(());
    }
    if filtered && !options.yes && !confirm(chosen.len())? {
        println!("nothing was cancelled");
        return Ok(());
    }
    let ids = chosen
        .iter()
        .map(|job| string(job, "id").to_owned())
        .collect::<Vec<_>>();
    let mut tally = Tally::default();
    for batch in ids.chunks(CANCEL_BATCH) {
        let request = json!({"v": 1, "id": "1", "t": "queue-cancel", "jobs": batch});
        control::request_streaming(socket, &request, |frame| {
            if frame.get("t").and_then(Value::as_str) != Some("queue-cancelled") {
                return;
            }
            let outcome = string(frame, "outcome");
            if ids.len() <= LISTED_OUTCOMES {
                println!(
                    "{}  {}",
                    short(string(frame, "job_id")),
                    outcome_words(outcome)
                );
            }
            tally.count(outcome);
        })
        .await?;
    }
    if ids.len() > LISTED_OUTCOMES {
        println!("{}", tally.summary());
    }
    Ok(())
}

fn confirm(count: usize) -> Result<bool> {
    if !std::io::stdin().is_terminal() {
        bail!("this would cancel {count} jobs; pass --yes to do it without a prompt");
    }
    print!("Cancel {count} jobs? This cannot be undone. [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes"))
}

async fn fetch(socket: &Path, selector: &Value) -> Result<Vec<Value>> {
    let mut request = selector.clone();
    request["v"] = json!(1);
    request["id"] = json!("1");
    request["t"] = json!("queue");
    let mut jobs = Vec::new();
    control::request_streaming(socket, &request, |frame| {
        if frame.get("t").and_then(Value::as_str) == Some("queue-job")
            && let Some(job) = frame.get("job")
        {
            jobs.push(job.clone());
        }
    })
    .await
    .context("could not read the queue")?;
    Ok(jobs)
}

#[derive(Default)]
struct Tally {
    cancelled: u32,
    stopping: u32,
    finishing: u32,
    finished: u32,
    gone: u32,
}

impl Tally {
    fn count(&mut self, outcome: &str) {
        match outcome {
            "cancelled" => self.cancelled += 1,
            "stopping" => self.stopping += 1,
            "finishing" => self.finishing += 1,
            "finished" => self.finished += 1,
            _ => self.gone += 1,
        }
    }

    fn summary(&self) -> String {
        let mut parts = vec![format!("{} cancelled", self.cancelled)];
        let others = [
            (self.stopping, "stopping"),
            (self.finishing, "too late, saving its song"),
            (self.finished + self.gone, "already over"),
        ];
        parts.extend(
            others
                .iter()
                .filter(|(count, _)| *count > 0)
                .map(|(count, words)| format!("{count} {words}")),
        );
        parts.join(", ")
    }
}

fn outcome_words(outcome: &str) -> &'static str {
    match outcome {
        "cancelled" => "cancelled",
        "stopping" => "stopping at the next safe point",
        "finishing" => "too late: its song is being saved",
        _ => "already over",
    }
}

fn render(jobs: &[Value], now: OffsetDateTime) -> String {
    if jobs.is_empty() {
        return "the queue is empty\n".to_owned();
    }
    let in_state = |wanted: &[&str]| {
        jobs.iter()
            .filter(|job| wanted.contains(&string(job, "state")))
            .collect::<Vec<_>>()
    };
    let queued = in_state(&["queued"]);
    let paused = in_state(&["paused"]);
    let active = jobs
        .iter()
        .filter(|job| !matches!(string(job, "state"), "queued" | "paused"))
        .collect::<Vec<_>>();

    let mut output = String::new();
    for job in &active {
        output.push_str(&row(&activity(job), job, now));
    }
    if !queued.is_empty() {
        output.push_str(&format!("\nwaiting ({})\n", queued.len()));
        for job in &queued {
            let position = job.get("position").and_then(Value::as_u64).unwrap_or(0);
            output.push_str(&row(&position.to_string(), job, now));
        }
    }
    if !paused.is_empty() {
        output.push_str(&format!("\npaused ({})\n", paused.len()));
        for job in &paused {
            output.push_str(&row("-", job, now));
        }
    }
    output
}

/// A paused or queued job has done nothing it can report, so only work in hand
/// is described by its stage.
fn activity(job: &Value) -> String {
    let stage = job.get("stage").and_then(Value::as_str);
    let progress = job.get("progress").and_then(|progress| {
        Some(format!(
            "{}/{}",
            progress.get("completed")?.as_u64()?,
            progress.get("total")?.as_u64()?
        ))
    });
    match (string(job, "state"), stage, progress) {
        ("running", Some(stage), Some(progress)) => format!("{stage} {progress}"),
        ("running", Some(stage), None) => stage.to_owned(),
        (state, ..) => state.to_owned(),
    }
}

fn row(lead: &str, job: &Value, now: OffsetDateTime) -> String {
    format!(
        "{lead:>14}  {}  {:<12}  {:<20}  {:>4}  {}\n",
        short(string(job, "id")),
        clipped(string(job, "owner"), 12),
        clipped(string(job, "model"), 20),
        age(string(job, "created_at"), now),
        clipped(&one_line(string(job, "caption")), CAPTION_WIDTH),
    )
}

fn render_one(job: &Value) -> String {
    let mut output = format!(
        "job      {}\nfrom     {}\nstate    {}\nmodel    {}\nasked    {}\n",
        string(job, "id"),
        string(job, "owner"),
        activity(job),
        string(job, "model"),
        string(job, "created_at"),
    );
    if let Some(position) = job.get("position").and_then(Value::as_u64) {
        output.push_str(&format!("place    {position}\n"));
    }
    output.push_str(&format!("caption  {}\n\n", string(job, "caption")));
    output
}

fn age(created_at: &str, now: OffsetDateTime) -> String {
    let Ok(created) = OffsetDateTime::parse(created_at, &Rfc3339) else {
        return "?".to_owned();
    };
    let seconds = (now - created).whole_seconds().max(0);
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3_600 => format!("{}m", seconds / 60),
        3_600..86_400 => format!("{}h", seconds / 3_600),
        _ => format!("{}d", seconds / 86_400),
    }
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clipped(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_owned();
    }
    let kept = text.chars().take(width - 1).collect::<String>();
    format!("{kept}…")
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    use super::{Tally, clipped, render};

    fn now() -> OffsetDateTime {
        OffsetDateTime::parse("2026-11-02T12:00:00Z", &Rfc3339).expect("time")
    }

    #[test]
    fn the_listing_reads_as_now_then_waiting_then_paused() {
        let jobs = [
            json!({"id": "aaaaaaaa-1", "state": "running", "stage": "diffuse", "owner": "alice",
                   "progress": {"completed": 12, "total": 50, "unit": "steps"},
                   "model": "acestep:1.5", "created_at": "2026-11-02T11:58:00Z",
                   "caption": "a slow\nblues"}),
            json!({"id": "bbbbbbbb-2", "state": "queued", "position": 1, "owner": "this node",
                   "model": "acestep:1.5", "created_at": "2026-11-02T10:00:00Z",
                   "caption": "next"}),
            json!({"id": "cccccccc-3", "state": "paused", "stage": "plan", "owner": "bo",
                   "model": "levo:2", "created_at": "2026-10-30T12:00:00Z",
                   "caption": "parked"}),
        ];
        let text = render(&jobs, now());
        let lines = text.lines().collect::<Vec<_>>();
        assert!(lines[0].contains("diffuse 12/50"), "{text}");
        assert!(lines[0].contains("aaaaaaaa"), "{text}");
        assert!(lines[0].contains("2m"), "{text}");
        assert!(lines[0].contains("a slow blues"), "{text}");
        assert!(text.contains("waiting (1)"), "{text}");
        assert!(text.contains("2h"), "{text}");
        assert!(text.contains("paused (1)"), "{text}");
        assert!(text.contains("3d"), "{text}");
        // A parked job that never ran has no stage to report.
        assert!(!text.contains("plan"), "{text}");
    }

    #[test]
    fn an_empty_queue_says_so() {
        assert_eq!(render(&[], now()), "the queue is empty\n");
    }

    #[test]
    fn clipping_counts_characters_not_bytes() {
        assert_eq!(clipped("déjà vu", 7), "déjà vu");
        assert_eq!(clipped("déjà vu!", 5), "déjà…");
    }

    #[test]
    fn a_tally_leads_with_cancellations_and_omits_what_did_not_happen() {
        let mut tally = Tally::default();
        for outcome in ["cancelled", "cancelled", "finishing", "gone"] {
            tally.count(outcome);
        }
        assert_eq!(
            tally.summary(),
            "2 cancelled, 1 too late, saving its song, 1 already over"
        );
    }
}
