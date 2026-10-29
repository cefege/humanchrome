//! Redacted diagnostic report generation for support workflows.

use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Value, json};
use tokio::{fs, io::AsyncWriteExt};

use super::{
    diagnostics::{DiagnosticScope, DoctorFormat, DoctorRequest, diagnostic_status_name, doctor},
    paths::BrowserSelection,
    registration::RegistrationContext,
};

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Output encoding for a support report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReportFormat {
    /// JSON for a machine reader or GitHub attachment.
    Json,
    /// Markdown suitable for a GitHub issue body.
    Markdown,
}

/// Amount of wrapper-log data included in a support report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IncludeLogs {
    /// Omit logs entirely.
    None,
    /// Include the last requested lines from each wrapper log.
    Tail,
    /// Include all readable wrapper logs.
    Full,
}
/// Inputs to a redacted support-report collection.
#[derive(Clone, Debug)]
pub struct ReportRequest {
    /// Report encoding.
    pub format: ReportFormat,
    /// Optional destination; absent means return the report to the caller.
    pub output: Option<PathBuf>,
    /// Whether user-home paths are redacted.
    pub redact: bool,
    /// Browsers inspected by the embedded doctor report.
    pub browsers: BrowserSelection,
    /// Whether the rendered report should also be copied to the system clipboard.
    pub copy: bool,
    /// Wrapper-log inclusion policy.
    pub include_logs: IncludeLogs,
    /// Maximum lines from each log under [`IncludeLogs::Tail`].
    pub log_lines: usize,
}

/// Result of generating a support report.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReportOutput {
    /// Report content.
    pub content: String,
    /// File destination written atomically, if requested.
    pub destination: Option<PathBuf>,
}

/// Collects a doctor-backed support report and optionally writes it atomically.
///
/// # Errors
/// Returns destination-write errors after report collection; callers retain no partially written file.
pub async fn report(
    context: &RegistrationContext,
    request: &ReportRequest,
) -> io::Result<ReportOutput> {
    let doctor = doctor(
        context,
        &DoctorRequest {
            host_path: None,
            browsers: request.browsers,
            scope: DiagnosticScope::Both,
            format: DoctorFormat::Json,
            fix: false,
        },
    )
    .await;
    let wrapper_logs = collect_wrapper_logs(request.include_logs, request.log_lines).await;
    let mut value = json!({
        "schemaVersion": 1,
        "tool": { "name": "humanchrome-native", "version": env!("CARGO_PKG_VERSION") },
        "environment": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "cwd": std::env::current_dir().ok(),
        },
        "doctor": {
            "generatedAtUnixMs": doctor.generated_at_unix_ms,
            "ok": doctor.is_healthy(),
            "findings": doctor.findings.iter().map(|finding| json!({
                "check": finding.check,
                "status": diagnostic_status_name(finding.status),
                "message": finding.message,
                "target": finding.target.as_ref().map(|target| json!({
                    "browser": target.browser.as_str(),
                    "scope": target.scope.to_string(),
                    "manifestPath": target.manifest_path,
                })),
            })).collect::<Vec<_>>(),
            "nextSteps": doctor.next_steps,
        },
        "wrapperLogs": wrapper_logs,
    });
    if request.redact {
        redact_paths(&mut value, dirs::home_dir().as_deref());
    }
    let content = match request.format {
        ReportFormat::Json => format!("{}\n", humanchrome_core::json::stringify(&value)),
        ReportFormat::Markdown => render_markdown(&value),
    };
    if let Some(destination) = &request.output {
        write_atomically(destination, content.as_bytes()).await?;
    }
    if request.copy {
        copy_to_clipboard(&content).await?;
    }
    Ok(ReportOutput {
        content,
        destination: request.output.clone(),
    })
}

fn redact_paths(value: &mut Value, home: Option<&Path>) {
    match value {
        Value::String(text) => {
            if let Some(home) = home {
                let home = home.to_string_lossy();
                if !home.is_empty() {
                    *text = text.replace(home.as_ref(), "<HOME>");
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_paths(item, home);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                redact_paths(item, home);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn render_markdown(value: &Value) -> String {
    let tool = &value["tool"];
    let environment = &value["environment"];
    let doctor = &value["doctor"];
    format!(
        "# {} Diagnostic Report\n\n## Environment\n\n- **OS:** {} ({})\n- **Working directory:** `{}`\n\n## Doctor\n\n```json\n{}\n```\n",
        tool["name"].as_str().unwrap_or("humanchrome-native"),
        environment["os"].as_str().unwrap_or("unknown"),
        environment["arch"].as_str().unwrap_or("unknown"),
        environment["cwd"],
        humanchrome_core::json::stringify(doctor),
    )
}

async fn write_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "report destination has no parent directory",
        )
    })?;
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".humanchrome-report.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    fs::write(&temporary, content).await?;
    if let Err(error) = fs::rename(&temporary, path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
}

async fn collect_wrapper_logs(mode: IncludeLogs, lines: usize) -> Value {
    if mode == IncludeLogs::None {
        return Value::Array(Vec::new());
    }
    let Some(home) = dirs::home_dir() else {
        return Value::Array(Vec::new());
    };
    let directory = if cfg!(target_os = "macos") {
        home.join("Library/Logs/humanchrome-bridge")
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("humanchrome-bridge/logs")
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/state"))
            .join("humanchrome-bridge/logs")
    };
    let Ok(mut entries) = fs::read_dir(directory).await else {
        return Value::Array(Vec::new());
    };
    let mut logs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path).await else {
            continue;
        };
        let text = match mode {
            IncludeLogs::None => String::new(),
            IncludeLogs::Tail => {
                let mut tail = text.lines().rev().take(lines).collect::<Vec<_>>();
                tail.reverse();
                tail.join("\n")
            }
            IncludeLogs::Full => text,
        };
        logs.push(json!({"path": path, "content": text}));
    }
    Value::Array(logs)
}

async fn copy_to_clipboard(content: &str) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let commands: &[(&str, &[&str])] = &[("pbcopy", &[])];
    #[cfg(target_os = "windows")]
    let commands: &[(&str, &[&str])] = &[("clip", &[])];
    #[cfg(all(unix, not(target_os = "macos")))]
    let commands: &[(&str, &[&str])] = &[
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];
    #[cfg(not(any(unix, target_os = "windows")))]
    let commands: &[(&str, &[&str])] = &[];

    let mut last_error = None;
    for (command, args) in commands {
        let mut child = match tokio::process::Command::new(command)
            .args(*args)
            .stdin(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(content.as_bytes()).await?;
        }
        match child.wait().await {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => {
                last_error = Some(io::Error::other(format!("{command} exited {status}")));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("no clipboard command available")))
}
