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
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

pub struct Options {
    /// The subcommand, then its jobs.
    pub positional: Vec<String>,
    pub all: bool,
    pub json: bool,
    pub yes: bool,
    pub from: Option<String>,
    pub model: Option<String>,
    pub watch: bool,
    pub interactive: bool,
    pub before: Option<String>,
    pub after: Option<String>,
}

pub async fn run(socket: &Path, options: Options) -> Result<()> {
    let (action, jobs) = match options.positional.split_first() {
        Some((action, jobs)) => (Some(action.as_str()), jobs),
        None => (None, &[][..]),
    };
    if options.interactive {
        return crate::queue_panel::run(socket).await;
    }
    if options.watch {
        return watch(socket).await;
    }
    match action {
        None => {
            let (jobs, facts) = fetch(socket, &json!({})).await?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&jobs)?);
            } else {
                print!("{}", render(&jobs, &facts, OffsetDateTime::now_utc()));
            }
            Ok(())
        }
        Some("show") => {
            if jobs.is_empty() {
                bail!("queue show needs a job, like `cantor queue show 3f2a91c0`");
            }
            let (found, _) = fetch(socket, &json!({"jobs": jobs})).await?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&found)?);
            } else {
                for job in &found {
                    print!("{}", render_one(job));
                }
            }
            Ok(())
        }
        Some(action @ ("cancel" | "hold" | "release")) => act(socket, action, jobs, &options).await,
        Some(place @ ("next" | "last")) => {
            let [job] = jobs else {
                bail!("queue {place} needs one job");
            };
            move_job(socket, job, place, None).await
        }
        Some("move") => {
            let [job] = jobs else {
                bail!("queue move needs one job");
            };
            match (&options.before, &options.after) {
                (Some(other), None) => move_job(socket, job, "before", Some(other)).await,
                (None, Some(other)) => move_job(socket, job, "after", Some(other)).await,
                _ => bail!("queue move needs --before <job> or --after <job>"),
            }
        }
        Some("clear") => clear(socket, &options).await,
        Some("now") => {
            let [job] = jobs else {
                bail!("queue now needs one job");
            };
            run_now(socket, job).await
        }
        Some(gate @ ("pause" | "resume" | "close" | "open")) => set_gate(socket, gate).await,
        Some(other) => bail!("queue has no command {other}; see `cantor --help`"),
    }
}

/// A fresh connection each time: a control connection carries a bounded number
/// of request bytes, so one held open would end.
async fn watch(socket: &Path) -> Result<()> {
    loop {
        let (jobs, facts) = fetch(socket, &json!({})).await?;
        print!(
            "\x1b[2J\x1b[H{}",
            render(&jobs, &facts, OffsetDateTime::now_utc())
        );
        std::io::stdout().flush()?;
        tokio::time::sleep(WATCH_EVERY).await;
    }
}

/// Select first, then confirm, then cancel exactly the ids that were confirmed:
/// a job arriving at the prompt is not one you agreed to lose.
async fn act(socket: &Path, action: &str, jobs: &[String], options: &Options) -> Result<()> {
    let filtered = options.all || options.from.is_some() || options.model.is_some();
    if jobs.is_empty() && !filtered {
        bail!("queue {action} needs jobs, or --all, --from or --model");
    }
    let selector = json!({"jobs": jobs, "all": options.all,
                          "from": options.from, "model": options.model});
    let (chosen, _) = fetch(socket, &selector).await?;
    if chosen.is_empty() {
        println!("nothing to {action}");
        return Ok(());
    }
    // Only a cancel is final; a hold and a release undo each other.
    if action == "cancel"
        && filtered
        && !options.yes
        && !confirm(&format!("Cancel {} jobs", chosen.len()))?
    {
        println!("nothing was cancelled");
        return Ok(());
    }
    let ids = chosen
        .iter()
        .map(|job| string(job, "id").to_owned())
        .collect::<Vec<_>>();
    let mut tally = Tally::default();
    for batch in ids.chunks(CANCEL_BATCH) {
        let request = json!({"v": 1, "id": "1", "t": format!("queue-{action}"), "jobs": batch});
        control::request_streaming(socket, &request, |frame| {
            if frame.get("t").and_then(Value::as_str) != Some("queue-acted") {
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
        println!("{}", tally.summary(action));
    }
    Ok(())
}

async fn move_job(socket: &Path, job: &str, place: &str, other: Option<&str>) -> Result<()> {
    let request = json!({"v": 1, "id": "1", "t": "queue-place", "job": job,
                         "place": place, "other": other});
    let answer = control::request_streaming(socket, &request, |_| {}).await?;
    let moved = answer.get("job").cloned().unwrap_or_default();
    println!(
        "{}  now {} in the queue",
        short(string(&moved, "id")),
        moved
            .get("position")
            .and_then(Value::as_u64)
            .unwrap_or_default()
    );
    Ok(())
}

async fn run_now(socket: &Path, job: &str) -> Result<()> {
    let request = json!({"v": 1, "id": "1", "t": "queue-now", "job": job});
    let answer = control::request_streaming(socket, &request, |_| {}).await?;
    let moved = answer.get("job").cloned().unwrap_or_default();
    match answer.get("displaced").and_then(Value::as_str) {
        Some(displaced) => println!(
            "{} runs next. {} stops at its next safe point and goes back in right after it",
            short(string(&moved, "id")),
            short(displaced)
        ),
        None => println!("{} runs next", short(string(&moved, "id"))),
    }
    Ok(())
}

async fn set_gate(socket: &Path, gate: &str) -> Result<()> {
    let request = json!({"v": 1, "id": "1", "t": "queue-gate", "gate": gate});
    control::request_streaming(socket, &request, |_| {}).await?;
    println!(
        "{}",
        match gate {
            "pause" => "paused: what is running finishes, nothing new starts",
            "resume" => "running again",
            "close" => "closed: new requests wait on the phones that sent them",
            _ => "open: apps can send requests again",
        }
    );
    Ok(())
}

async fn clear(socket: &Path, options: &Options) -> Result<()> {
    let count_request = json!({"v": 1, "id": "1", "t": "queue-clear",
                               "from": options.from, "count_only": true});
    let answer = control::request_streaming(socket, &count_request, |_| {}).await?;
    let count = answer.get("count").and_then(Value::as_u64).unwrap_or(0);
    if count == 0 {
        println!("nothing to clear");
        return Ok(());
    }
    if !options.yes && !confirm(&format!("Forget {count} failed and cancelled jobs"))? {
        println!("nothing was cleared");
        return Ok(());
    }
    let request = json!({"v": 1, "id": "1", "t": "queue-clear", "from": options.from});
    let answer = control::request_streaming(socket, &request, |_| {}).await?;
    println!(
        "forgot {} jobs",
        answer.get("count").and_then(Value::as_u64).unwrap_or(0)
    );
    Ok(())
}

fn confirm(what: &str) -> Result<bool> {
    if !std::io::stdin().is_terminal() {
        bail!("{what}? Pass --yes to do it without a prompt");
    }
    print!("{what}? This cannot be undone. [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes"))
}

/// The jobs, and the closing frame's facts about the queue as a whole.
pub(crate) async fn fetch(socket: &Path, selector: &Value) -> Result<(Vec<Value>, Value)> {
    let mut request = selector.clone();
    request["v"] = json!(1);
    request["id"] = json!("1");
    request["t"] = json!("queue");
    let mut jobs = Vec::new();
    let facts = control::request_streaming(socket, &request, |frame| {
        if frame.get("t").and_then(Value::as_str) == Some("queue-job")
            && let Some(job) = frame.get("job")
        {
            jobs.push(job.clone());
        }
    })
    .await
    .context("could not read the queue")?;
    Ok((jobs, facts))
}

#[derive(Default)]
struct Tally {
    done: u32,
    stopping: u32,
    finishing: u32,
    other: u32,
}

impl Tally {
    fn count(&mut self, outcome: &str) {
        match outcome {
            "cancelled" | "held" | "released" => self.done += 1,
            "stopping" => self.stopping += 1,
            "finishing" => self.finishing += 1,
            _ => self.other += 1,
        }
    }

    fn summary(&self, action: &str) -> String {
        let mut parts = vec![format!("{} {}", self.done, past_tense(action))];
        let others = [
            (self.stopping, "stopping"),
            (self.finishing, "too late, saving its song"),
            (self.other, "unchanged"),
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

fn past_tense(action: &str) -> &'static str {
    match action {
        "hold" => "held",
        "release" => "released",
        _ => "cancelled",
    }
}

fn outcome_words(outcome: &str) -> &'static str {
    match outcome {
        "cancelled" => "cancelled",
        "held" => "held until you release it",
        "released" => "back in the queue",
        "stopping" => "stopping at the next safe point",
        "finishing" => "too late: its song is being saved",
        "gone" => "gone",
        _ => "unchanged",
    }
}

/// Whole-queue state goes first: it explains everything below it.
pub(crate) fn banner(facts: &Value) -> String {
    let flag = |key: &str| facts.get(key).and_then(Value::as_bool) == Some(true);
    let mut output = String::new();
    if flag("paused") {
        output.push_str("paused: nothing new starts until `cantor queue resume`\n");
    }
    if flag("closed") {
        output.push_str("closed to apps: their requests wait until `cantor queue open`\n");
    }
    output
}

fn render(jobs: &[Value], facts: &Value, now: OffsetDateTime) -> String {
    let mut output = banner(facts);
    if jobs.is_empty() {
        output.push_str("the queue is empty\n");
        return output;
    }
    let in_state = |wanted: &[&str]| {
        jobs.iter()
            .filter(|job| wanted.contains(&string(job, "state")))
            .collect::<Vec<_>>()
    };
    let queued = in_state(&["queued"]);
    let (held, paused): (Vec<_>, Vec<_>) = in_state(&["paused"])
        .into_iter()
        .partition(|job| job.get("by_node_owner").and_then(Value::as_bool) == Some(true));
    let active = jobs
        .iter()
        .filter(|job| !matches!(string(job, "state"), "queued" | "paused"))
        .collect::<Vec<_>>();

    for job in &active {
        output.push_str(&row(&activity(job), job, now));
    }
    if !queued.is_empty() {
        let left = facts
            .get("job_seconds")
            .and_then(Value::as_u64)
            .map(|seconds| {
                let total = seconds.saturating_mul(queued.len() as u64);
                format!(", about {}", rough_duration(total))
            })
            .unwrap_or_default();
        output.push_str(&format!("\nwaiting ({}{left})\n", queued.len()));
        for job in &queued {
            let position = job.get("position").and_then(Value::as_u64).unwrap_or(0);
            output.push_str(&row(&position.to_string(), job, now));
        }
    }
    for (name, jobs) in [("held", &held), ("paused", &paused)] {
        if !jobs.is_empty() {
            output.push_str(&format!("\n{name} ({})\n", jobs.len()));
            for job in jobs {
                output.push_str(&row("-", job, now));
            }
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

pub(crate) fn row(lead: &str, job: &Value, now: OffsetDateTime) -> String {
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

fn rough_duration(seconds: u64) -> String {
    match seconds {
        0..3_600 => format!("{}m", (seconds / 60).max(1)),
        3_600..86_400 => format!("{}h {}m", seconds / 3_600, seconds % 3_600 / 60),
        _ => format!("{}d {}h", seconds / 86_400, seconds % 86_400 / 3_600),
    }
}

pub(crate) fn short(id: &str) -> &str {
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

pub(crate) fn string<'a>(value: &'a Value, key: &str) -> &'a str {
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
            json!({"id": "dddddddd-4", "state": "paused", "owner": "bo", "by_node_owner": true,
                   "model": "levo:2", "created_at": "2026-10-30T12:00:00Z",
                   "caption": "kept"}),
        ];
        let facts = json!({"paused": true, "closed": false, "job_seconds": 90});
        let text = render(&jobs, &facts, now());
        let lines = text.lines().collect::<Vec<_>>();
        assert!(lines[0].starts_with("paused:"), "{text}");
        assert!(lines[1].contains("diffuse 12/50"), "{text}");
        assert!(lines[1].contains("aaaaaaaa"), "{text}");
        assert!(lines[1].contains("2m"), "{text}");
        assert!(lines[1].contains("a slow blues"), "{text}");
        assert!(text.contains("waiting (1, about 1m)"), "{text}");
        assert!(text.contains("2h"), "{text}");
        assert!(text.contains("paused (1)"), "{text}");
        assert!(text.contains("held (1)"), "{text}");
        assert!(text.contains("3d"), "{text}");
        // A parked job that never ran has no stage to report.
        assert!(!text.contains("plan"), "{text}");
    }

    #[test]
    fn an_empty_queue_says_so() {
        assert_eq!(render(&[], &json!({}), now()), "the queue is empty\n");
    }

    #[test]
    fn clipping_counts_characters_not_bytes() {
        assert_eq!(clipped("déjà vu", 7), "déjà vu");
        assert_eq!(clipped("déjà vu!", 5), "déjà…");
    }

    #[test]
    fn a_tally_leads_with_cancellations_and_omits_what_did_not_happen() {
        let mut tally = Tally::default();
        for outcome in ["held", "held", "finishing", "gone"] {
            tally.count(outcome);
        }
        assert_eq!(
            tally.summary("hold"),
            "2 held, 1 too late, saving its song, 1 unchanged"
        );
    }
}
