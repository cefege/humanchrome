//! Command parsing and composable native CLI handlers.

use std::{ffi::OsString, fmt::Write as _, path::PathBuf};

use serde_json::{Value, json};

use super::{
    diagnostics::{
        DiagnosticScope, DoctorFormat, DoctorReport, DoctorRequest, diagnostic_status_name, doctor,
    },
    fleet::{FleetAgent, FleetCommand, ProfileAction, serve_fleet},
    install::{NativeBundleInstallRequest, current_bundle_root, install_and_register_bundle},
    maintenance::{fix_permissions, update_port},
    paths::{BrowserSelection, ManifestScope},
    registration::{
        ExistingManifest, ManifestOutcome, RegistrationContext, RegistrationReport,
        RegistrationRequest, UnregistrationRequest, register, unregister,
    },
    report::{IncludeLogs, ReportFormat, ReportRequest, report},
};

/// Semantic commands supported by the Rust native CLI module.
#[derive(Clone, Debug)]
pub enum CliCommand {
    /// Install an already-built native host by registering it for Chrome native messaging.
    Install(RegistrationRequest),
    /// Stage the invoking complete native bundle, then register its installed native host.
    InstallBundle(RegistrationRequest),
    /// Register an already-built native host for Chrome native messaging.
    Register(RegistrationRequest),
    /// Remove registrations that still exactly match the supplied native host.
    Unregister(UnregistrationRequest),
    /// Inspect installation state without modifying any file or Registry key.
    Doctor(DoctorRequest),
    /// Restore launch permissions on the installed native host executable.
    FixPermissions { host_path: Option<PathBuf> },
    /// Update the port in a bridge stdio configuration file.
    UpdatePort {
        port: u16,
        config_path: Option<PathBuf>,
    },
    /// Generate a redacted diagnostic report, optionally to an explicit destination.
    Report(ReportRequest),
    /// Start a real fleet worker or coordinator server.
    Fleet(Box<FleetCommand>),
    /// Display command usage and integration boundaries.
    Help,
    /// Display the package version.
    Version,
}

/// Parse failure for user-provided native CLI arguments.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CliParseError {
    /// A command requires a value-bearing option that was omitted.
    #[error("missing required option {option} for {command}; run `humanchrome-native help`")]
    MissingOption {
        /// Missing option spelling.
        option: &'static str,
        /// Command which requires it.
        command: &'static str,
    },
    /// A value-bearing option did not include a value.
    #[error("option {option} requires a value")]
    MissingValue {
        /// Option spelling.
        option: String,
    },
    /// A supplied option is not supported for the selected command.
    #[error("unknown option {option:?} for {command}; run `humanchrome-native help`")]
    UnknownOption {
        /// Command selected by the user.
        command: String,
        /// Unsupported option spelling.
        option: String,
    },

    /// The selected command is not part of the native command surface.
    #[error("unknown command {command:?}; run `humanchrome-native help`")]
    UnknownCommand {
        /// Unknown command spelling.
        command: String,
    },

    /// A non-option argument has no meaning for the selected command.
    #[error("unexpected argument {argument:?} for {command}; run `humanchrome-native help`")]
    UnexpectedArgument {
        /// Command selected by the user.
        command: String,
        /// Unexpected value.
        argument: String,
    },
    /// Browser selection retains its accepted spellings in the error.
    #[error(transparent)]
    Browser(#[from] super::paths::ParseBrowserError),
    /// The configured MCP bridge port is outside the valid TCP range.
    #[error("port must be a number between 1 and 65535")]
    InvalidPort,
    /// Host paths must be valid OS-native strings.
    #[error("--host-path is not valid Unicode")]
    NonUnicodeHostPath,
    /// The installed CLI location cannot determine its sibling native host.
    #[error("could not resolve sibling native host: {0}")]
    DefaultHostPath(String),
    /// Report tail length must be a positive decimal line count.
    #[error("--log-lines must be a positive integer")]
    InvalidLogLines,
}

/// Process-independent command output used by native executable entry points.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliOutput {
    /// Conventional process result code; zero means the requested effects all completed.
    pub exit_code: u8,
    /// User-facing normal output.
    pub stdout: String,
    /// User-facing errors and unsupported-operation instructions.
    pub stderr: String,
}

impl CliOutput {
    pub(super) fn success(stdout: String) -> Self {
        Self {
            exit_code: 0,
            stdout,
            stderr: String::new(),
        }
    }

    fn failure(stderr: String) -> Self {
        Self {
            exit_code: 1,
            stdout: String::new(),
            stderr,
        }
    }
}

/// Parses command arguments excluding the process executable name.
///
/// # Errors
/// Returns an actionable error without creating, deleting, or modifying any installation file.
pub fn parse_args(args: &[OsString]) -> Result<CliCommand, CliParseError> {
    let Some(command) = args.first() else {
        return Ok(CliCommand::Help);
    };
    let command = command.to_string_lossy();
    match command.as_ref() {
        "help" | "--help" | "-h" => require_no_args("help", &args[1..]).map(|()| CliCommand::Help),
        "version" | "--version" | "-V" => {
            require_no_args("version", &args[1..]).map(|()| CliCommand::Version)
        }
        "install" => parse_registration("install", &args[1..], true).map(|(request, explicit)| {
            if explicit {
                CliCommand::Install(request)
            } else {
                CliCommand::InstallBundle(request)
            }
        }),
        "register" => {
            parse_registration("register", &args[1..], true).map(|(request, explicit)| {
                if explicit {
                    CliCommand::Register(request)
                } else {
                    CliCommand::InstallBundle(request)
                }
            })
        }
        "unregister" => parse_unregistration(&args[1..]).map(CliCommand::Unregister),
        "fix-permissions" => parse_fix_permissions(&args[1..])
            .map(|host_path| CliCommand::FixPermissions { host_path }),
        "update-port" => parse_update_port(&args[1..])
            .map(|(port, config_path)| CliCommand::UpdatePort { port, config_path }),
        "doctor" => parse_doctor(&args[1..]).map(CliCommand::Doctor),
        "report" => parse_report(&args[1..]).map(CliCommand::Report),
        "fleet" => parse_fleet(&args[1..]).map(|command| CliCommand::Fleet(Box::new(command))),
        other => Err(CliParseError::UnknownCommand {
            command: other.to_owned(),
        }),
    }
}

/// Executes a parsed command without calling `process::exit` or writing directly to stdio.
pub async fn execute(context: &RegistrationContext, command: &CliCommand) -> CliOutput {
    match command {
        CliCommand::Install(request) => match register(context, request).await {
            Ok(report) => output_from_report("Installed", &report),
            Err(error) => CliOutput::failure(format!("installation refused: {error}\n")),
        },
        CliCommand::InstallBundle(request) => {
            let bundle_root = match current_bundle_root() {
                Ok(bundle_root) => bundle_root,
                Err(error) => {
                    return CliOutput::failure(format!(
                        "installation refused: could not resolve native bundle: {error}\n"
                    ));
                }
            };
            match install_and_register_bundle(
                context,
                &NativeBundleInstallRequest {
                    bundle_root,
                    registration: request.clone(),
                },
            )
            .await
            {
                Ok(report) => output_from_report("Installed", &report.registration),
                Err(error) => CliOutput::failure(format!("installation refused: {error}\n")),
            }
        }
        CliCommand::Register(request) => match register(context, request).await {
            Ok(report) => output_from_report("Registered", &report),
            Err(error) => CliOutput::failure(format!("registration refused: {error}\n")),
        },
        CliCommand::Unregister(request) => match unregister(context, request).await {
            Ok(report) => output_from_report("Unregistered", &report),
            Err(error) => CliOutput::failure(format!("unregistration refused: {error}\n")),
        },
        CliCommand::FixPermissions { host_path } => {
            let path = host_path.clone().map_or_else(default_native_host_path, Ok);
            match path {
                Ok(path) => match fix_permissions(&path).await {
                    Ok(result) => CliOutput::success(format!(
                        "{} permissions for {}\\n",
                        if result.changed {
                            "restored"
                        } else {
                            "verified"
                        },
                        result.path.display()
                    )),
                    Err(error) => {
                        CliOutput::failure(format!("failed to fix permissions: {error}\\n"))
                    }
                },
                Err(error) => {
                    CliOutput::failure(format!("failed to resolve native host: {error}\\n"))
                }
            }
        }
        CliCommand::UpdatePort { port, config_path } => {
            let path = config_path
                .clone()
                .map_or_else(default_stdio_config_path, Ok);
            match path {
                Ok(path) => match update_port(&path, *port).await {
                    Ok(url) => CliOutput::success(format!(
                        "port updated to {port}\\nupdated URL: {url}\\n"
                    )),
                    Err(error) => CliOutput::failure(format!("failed to update port: {error}\\n")),
                },
                Err(error) => {
                    CliOutput::failure(format!("failed to resolve stdio config: {error}\\n"))
                }
            }
        }
        CliCommand::Report(request) => match report(context, request).await {
            Ok(output) => {
                let mut stdout = output.content;
                if let Some(destination) = output.destination {
                    stdout.push_str(&format!("report written to {}\\n", destination.display()));
                }
                CliOutput::success(stdout)
            }
            Err(error) => CliOutput::failure(format!("failed to generate report: {error}\\n")),
        },
        CliCommand::Fleet(command) => match serve_fleet(context, command).await {
            Ok(output) => output,
            Err(error) => CliOutput::failure(format!("fleet command failed: {error}\n")),
        },
        CliCommand::Doctor(request) => {
            if request.fix {
                let host_path = request
                    .host_path
                    .clone()
                    .map_or_else(default_native_host_path, Ok);
                match host_path {
                    Ok(host_path) => {
                        if let Err(error) = fix_permissions(&host_path).await {
                            return CliOutput::failure(format!("doctor fix failed: {error}\n"));
                        }
                    }
                    Err(error) => {
                        return CliOutput::failure(format!("doctor fix failed: {error}\n"));
                    }
                }
            }
            render_doctor(&doctor(context, request).await, request.format)
        }
        CliCommand::Help => CliOutput::success(help_text().to_owned()),
        CliCommand::Version => CliOutput::success(format!("{}\n", env!("CARGO_PKG_VERSION"))),
    }
}

fn output_from_report(verb: &str, report: &RegistrationReport) -> CliOutput {
    let output = render_registration(verb, report);
    if report.is_success() {
        CliOutput::success(output)
    } else {
        CliOutput::failure(output)
    }
}

fn parse_fix_permissions(args: &[OsString]) -> Result<Option<PathBuf>, CliParseError> {
    match args {
        [] => Ok(None),
        [flag, path] if flag == "--host-path" => Ok(Some(PathBuf::from(path))),
        [argument, ..] if argument.to_string_lossy().starts_with('-') => {
            Err(CliParseError::UnknownOption {
                command: "fix-permissions".to_owned(),
                option: argument.to_string_lossy().into_owned(),
            })
        }
        [argument, ..] => Err(CliParseError::UnexpectedArgument {
            command: "fix-permissions".to_owned(),
            argument: argument.to_string_lossy().into_owned(),
        }),
    }
}

fn parse_update_port(args: &[OsString]) -> Result<(u16, Option<PathBuf>), CliParseError> {
    let Some(port) = args.first() else {
        return Err(CliParseError::MissingOption {
            option: "<port>",
            command: "update-port",
        });
    };
    let port = port
        .to_string_lossy()
        .parse::<u16>()
        .map_err(|_| CliParseError::InvalidPort)?;
    if port == 0 {
        return Err(CliParseError::InvalidPort);
    }
    match &args[1..] {
        [] => Ok((port, None)),
        [flag, path] if flag == "--config" => Ok((port, Some(PathBuf::from(path)))),
        [argument, ..] if argument.to_string_lossy().starts_with('-') => {
            Err(CliParseError::UnknownOption {
                command: "update-port".to_owned(),
                option: argument.to_string_lossy().into_owned(),
            })
        }
        [argument, ..] => Err(CliParseError::UnexpectedArgument {
            command: "update-port".to_owned(),
            argument: argument.to_string_lossy().into_owned(),
        }),
    }
}

fn default_native_host_path() -> Result<PathBuf, CliParseError> {
    let executable = std::env::current_exe()
        .map_err(|error| CliParseError::DefaultHostPath(error.to_string()))?;
    let directory = executable.parent().ok_or_else(|| {
        CliParseError::DefaultHostPath("native CLI executable has no parent directory".to_owned())
    })?;
    Ok(directory.join(if cfg!(windows) {
        "humanchrome-nativehost.exe"
    } else {
        "humanchrome-nativehost"
    }))
}

fn default_stdio_config_path() -> std::io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let directory = executable.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "native executable has no parent directory",
        )
    })?;
    Ok(directory.join("mcp/stdio-config.json"))
}

fn parse_fleet(args: &[OsString]) -> Result<FleetCommand, CliParseError> {
    let role =
        args.first()
            .and_then(|value| value.to_str())
            .ok_or(CliParseError::MissingOption {
                option: "<command>",
                command: "fleet",
            })?;
    let mut root = None;
    let mut home = None;
    let mut base_port_explicit = false;
    let mut host_path = None;
    let mut chrome_path = None;
    let mut extension_dir = None;
    let mut config_path = None;
    let mut gateway_port = 12300;
    let mut base_port = 12500;
    let mut peer_port = 12300;
    let mut worker_port = 12320;
    let mut token = None;
    let mut worker_host = None;
    let mut delete_data = false;
    let mut print_token = false;
    let mut force_new_token = false;
    let mut allow_agent_install = false;
    let mut labels = Vec::new();
    let mut seed = None;
    let mut no_seed = false;
    let mut allow_profiles = Vec::new();
    let mut seed_sources = Vec::new();
    let mut positionals = Vec::new();
    let mut index = 1;
    while let Some(argument) = args.get(index) {
        let argument = argument.to_string_lossy();
        match argument.as_ref() {
            "--root" => root = Some(next_path(args, &mut index, "--root")?),
            "--home" => home = Some(next_path(args, &mut index, "--home")?),
            "--base-port" => {
                base_port = parse_fleet_port(next_string(args, &mut index, "--base-port")?)?;
                base_port_explicit = true;
            }
            "--host-path" => host_path = Some(next_path(args, &mut index, "--host-path")?),
            "--chrome-path" => chrome_path = Some(next_path(args, &mut index, "--chrome-path")?),
            "--extension-dir" => {
                extension_dir = Some(next_path(args, &mut index, "--extension-dir")?)
            }
            "--config" => config_path = Some(next_path(args, &mut index, "--config")?),
            "--gateway-port" => {
                gateway_port = parse_fleet_port(next_string(args, &mut index, "--gateway-port")?)?
            }
            "--port" => {
                let port = parse_fleet_port(next_string(args, &mut index, "--port")?)?;
                peer_port = port;
                worker_port = port;
            }
            "--host" => worker_host = Some(next_string(args, &mut index, "--host")?),
            "--token" => token = Some(next_string(args, &mut index, "--token")?),
            "--delete-data" => delete_data = true,
            "--print-token" => print_token = true,
            "--force-new-token" => force_new_token = true,
            "--allow-agent-install" => allow_agent_install = true,
            "--labels" => {
                labels = next_string(args, &mut index, "--labels")?
                    .split(',')
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            "--seed" => seed = Some(next_path(args, &mut index, "--seed")?),
            "--no-seed" => no_seed = true,
            "--allow-profile" => {
                allow_profiles.push(next_string(args, &mut index, "--allow-profile")?)
            }
            "--seed-source" => seed_sources.push(next_string(args, &mut index, "--seed-source")?),
            "--json" => {}
            option if option.starts_with('-') => {
                return Err(CliParseError::UnknownOption {
                    command: "fleet".into(),
                    option: option.into(),
                });
            }
            value => positionals.push(value.to_owned()),
        }
        index += 1;
    }
    let home = home
        .or_else(dirs::home_dir)
        .ok_or(CliParseError::MissingOption {
            option: "--home",
            command: "fleet",
        })?;
    let root = root
        .or_else(|| std::env::var_os("HC_FLEET_ROOT").map(PathBuf::from))
        .unwrap_or_else(|| home.join("Library/Application Support/humanchrome-fleet"));
    let host_path = host_path.or_else(|| {
        std::env::current_exe().ok().and_then(|path| {
            path.parent().map(|parent| {
                parent.join(if cfg!(windows) {
                    "humanchrome-nativehost.exe"
                } else {
                    "humanchrome-nativehost"
                })
            })
        })
    });
    let required = |index: usize, name: &'static str, command: &'static str| {
        positionals
            .get(index)
            .cloned()
            .ok_or(CliParseError::MissingOption {
                option: name,
                command,
            })
    };
    let action = positionals.first().map(String::as_str);
    if (chrome_path.is_some() || extension_dir.is_some())
        && !matches!((role, action), ("worker", Some("init" | "enroll")))
    {
        return Err(CliParseError::UnknownOption {
            command: "fleet".into(),
            option: if chrome_path.is_some() {
                "--chrome-path"
            } else {
                "--extension-dir"
            }
            .into(),
        });
    }
    let host_path = |command| {
        host_path.clone().ok_or(CliParseError::MissingOption {
            option: "--host-path",
            command,
        })
    };

    match (role, action) {
        ("worker", Some("serve")) => Ok(FleetCommand::WorkerServe {
            root,
            home,
            host_path: host_path("fleet worker serve")?,
        }),
        ("worker", Some("init" | "enroll")) => Ok(FleetCommand::WorkerInit {
            root,
            home,
            host_path: host_path("fleet worker init")?,
            id: required(1, "<id>", "fleet worker init")?,
            host: worker_host.ok_or(CliParseError::MissingOption {
                option: "--host",
                command: "fleet worker init",
            })?,
            port: worker_port,
            base_port: if base_port_explicit { base_port } else { 12900 },
            token,
            profiles: allow_profiles,
            seed_sources,
            chrome_path,
            extension_dir,
        }),
        ("worker", Some("install-agent")) => Ok(FleetCommand::AgentInstall {
            root,
            home,
            host_path: host_path("fleet worker install-agent")?,
            agent: FleetAgent::Worker,
            allow_agent_install,
        }),
        ("worker", Some("uninstall-agent")) => Ok(FleetCommand::AgentUninstall {
            root,
            home,
            agent: FleetAgent::Worker,
            allow_agent_install,
        }),
        ("gateway", Some("serve")) | ("serve", None) => Ok(FleetCommand::GatewayServe {
            root,
            home,
            host_path: host_path("fleet serve")?,
        }),
        ("coordinator", None | Some("serve")) => Ok(FleetCommand::CoordinatorServe {
            config_path: config_path.ok_or(CliParseError::MissingOption {
                option: "--config",
                command: "fleet coordinator",
            })?,
        }),
        ("init", None) => Ok(FleetCommand::Init {
            root,
            home,
            gateway_port,
            base_port,
            token,
            print_token,
            force_new_token,
        }),
        ("template", Some("init")) => Ok(FleetCommand::TemplateInit {
            root,
            home,
            host_path: host_path("fleet template init")?,
        }),
        ("profile", Some("add")) => Ok(FleetCommand::ProfileAdd {
            root,
            home,
            host_path: host_path("fleet profile add")?,
            name: required(1, "<name>", "fleet profile add")?,
            labels,
            seed,
            no_seed,
        }),
        ("profile", Some("verify")) => Ok(FleetCommand::ProfileVerify {
            root,
            home,
            name: required(1, "<name>", "fleet profile verify")?,
        }),
        ("profile", Some("ls")) => Ok(FleetCommand::ProfileList { root, home }),
        ("profile", Some("rm")) => Ok(FleetCommand::ProfileRemove {
            root,
            home,
            name: required(1, "<name>", "fleet profile rm")?,
            delete_data,
        }),
        ("profile", Some("enable" | "disable")) => Ok(FleetCommand::ProfileEnable {
            root,
            home,
            name: required(1, "<name>", "fleet profile enable")?,
            enabled: action == Some("enable"),
        }),
        ("start" | "stop" | "restart", _) => {
            let action = match role {
                "start" => ProfileAction::Start,
                "stop" => ProfileAction::Stop,
                "restart" => ProfileAction::Restart,
                _ => unreachable!("matched lifecycle command"),
            };
            Ok(FleetCommand::ProfileControl {
                root,
                home,
                name: required(0, "<name>", "fleet profile lifecycle")?,
                action,
            })
        }
        ("status", None) => Ok(FleetCommand::Status { root, home }),
        ("up", None) | ("down", None) => Ok(FleetCommand::Park {
            root,
            home,
            parked: role == "down",
        }),
        ("node", Some("ls")) => Ok(FleetCommand::NodeList { root, home }),
        ("node", Some("add")) => Ok(FleetCommand::NodeAdd {
            root,
            home,
            id: required(1, "<id>", "fleet node add")?,
            host: required(2, "<host>", "fleet node add")?,
            port: peer_port,
            token,
        }),
        ("node", Some("rm")) => Ok(FleetCommand::NodeRemove {
            root,
            home,
            id: required(1, "<id>", "fleet node rm")?,
        }),
        ("purpose", Some("ls")) => Ok(FleetCommand::PurposeList { root, home }),
        ("purpose", Some("add")) => Ok(FleetCommand::PurposeAdd {
            root,
            home,
            purpose: required(1, "<purpose>", "fleet purpose add")?,
            profile: required(2, "<profile>", "fleet purpose add")?,
        }),
        ("purpose", Some("rm")) => Ok(FleetCommand::PurposeRemove {
            root,
            home,
            purpose: required(1, "<purpose>", "fleet purpose rm")?,
        }),
        ("install-agent", None) => Ok(FleetCommand::AgentInstall {
            root,
            home,
            host_path: host_path("fleet install-agent")?,
            agent: FleetAgent::Gateway,
            allow_agent_install,
        }),
        ("uninstall-agent", None) => Ok(FleetCommand::AgentUninstall {
            root,
            home,
            agent: FleetAgent::Gateway,
            allow_agent_install,
        }),
        _ => Err(CliParseError::UnexpectedArgument {
            command: "fleet".into(),
            argument: format!("{role} {}", action.unwrap_or("")),
        }),
    }
}

fn parse_fleet_port(value: String) -> Result<u16, CliParseError> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or(CliParseError::InvalidPort)
}

fn parse_report(args: &[OsString]) -> Result<ReportRequest, CliParseError> {
    let mut format = ReportFormat::Markdown;
    let mut output = None;
    let mut redact = true;
    let mut copy = false;
    let mut include_logs = IncludeLogs::Tail;
    let mut log_lines = 200;
    let mut browsers = BrowserSelection::default();
    let mut index = 0;
    while let Some(argument) = args.get(index) {
        let argument = argument.to_string_lossy();
        match argument.as_ref() {
            "--json" => format = ReportFormat::Json,
            "--copy" => copy = true,
            "--no-redact" => redact = false,
            "--include-logs" => {
                include_logs = match next_string(args, &mut index, "--include-logs")?.as_str() {
                    "none" => IncludeLogs::None,
                    "tail" => IncludeLogs::Tail,
                    "full" => IncludeLogs::Full,
                    value => {
                        return Err(CliParseError::UnexpectedArgument {
                            command: "report --include-logs".to_owned(),
                            argument: value.to_owned(),
                        });
                    }
                };
            }
            "--log-lines" => {
                log_lines = next_string(args, &mut index, "--log-lines")?
                    .parse::<usize>()
                    .ok()
                    .filter(|lines| *lines > 0)
                    .ok_or(CliParseError::InvalidLogLines)?;
            }
            "--browser" | "-b" => {
                browsers = next_string(args, &mut index, "--browser")?.parse()?;
            }
            "--output" => output = Some(next_path(args, &mut index, "--output")?),
            option if option.starts_with('-') => {
                return Err(CliParseError::UnknownOption {
                    command: "report".to_owned(),
                    option: option.to_owned(),
                });
            }
            value => {
                return Err(CliParseError::UnexpectedArgument {
                    command: "report".to_owned(),
                    argument: value.to_owned(),
                });
            }
        }
        index += 1;
    }
    Ok(ReportRequest {
        format,
        output,
        redact,
        browsers,
        copy,
        include_logs,
        log_lines,
    })
}

fn parse_registration(
    command: &'static str,
    args: &[OsString],
    supports_force: bool,
) -> Result<(RegistrationRequest, bool), CliParseError> {
    let mut host_path = None;
    let mut browsers = BrowserSelection::default();
    let mut scope = ManifestScope::User;
    let mut existing = ExistingManifest::Refuse;
    let mut index = 0;
    while let Some(argument) = args.get(index) {
        let argument = argument.to_string_lossy();
        match argument.as_ref() {
            "--host-path" => {
                host_path = Some(next_path(args, &mut index, "--host-path")?);
            }
            "--browser" | "-b" => {
                browsers = next_string(args, &mut index, argument.as_ref())?.parse()?;
            }
            "--system" | "-s" => scope = ManifestScope::System,
            "--force" | "-f" if supports_force => existing = ExistingManifest::ReplaceOwned,
            "--detect" | "-d" => browsers = BrowserSelection::Detected,
            option if option.starts_with('-') => {
                return Err(CliParseError::UnknownOption {
                    command: command.to_owned(),
                    option: option.to_owned(),
                });
            }
            value => {
                return Err(CliParseError::UnexpectedArgument {
                    command: command.to_owned(),
                    argument: value.to_owned(),
                });
            }
        }
        index += 1;
    }
    let explicit_host_path = host_path.is_some();
    let host_path = host_path.map_or_else(default_native_host_path, Ok)?;
    Ok((
        RegistrationRequest {
            host_path,
            browsers,
            scope,
            existing,
        },
        explicit_host_path,
    ))
}

fn parse_unregistration(args: &[OsString]) -> Result<UnregistrationRequest, CliParseError> {
    let (request, _) = parse_registration("unregister", args, false)?;
    Ok(UnregistrationRequest {
        host_path: request.host_path,
        browsers: request.browsers,
        scope: request.scope,
    })
}

fn parse_doctor(args: &[OsString]) -> Result<DoctorRequest, CliParseError> {
    let mut host_path = None;
    let mut browsers = BrowserSelection::default();
    let mut scope = DiagnosticScope::default();
    let mut format = DoctorFormat::default();
    let mut fix = false;
    let mut index = 0;
    while let Some(argument) = args.get(index) {
        let argument = argument.to_string_lossy();
        match argument.as_ref() {
            "--host-path" => host_path = Some(next_path(args, &mut index, "--host-path")?),
            "--browser" | "-b" => {
                browsers = next_string(args, &mut index, argument.as_ref())?.parse()?;
            }
            "--system" | "-s" => scope = DiagnosticScope::System,
            "--user" => scope = DiagnosticScope::User,
            "--all-scopes" => scope = DiagnosticScope::Both,
            "--json" => format = DoctorFormat::Json,
            "--fix" => fix = true,
            option if option.starts_with('-') => {
                return Err(CliParseError::UnknownOption {
                    command: "doctor".to_owned(),
                    option: option.to_owned(),
                });
            }
            value => {
                return Err(CliParseError::UnexpectedArgument {
                    command: "doctor".to_owned(),
                    argument: value.to_owned(),
                });
            }
        }
        index += 1;
    }
    Ok(DoctorRequest {
        host_path,
        browsers,
        scope,
        format,
        fix,
    })
}

fn next_string(
    args: &[OsString],
    index: &mut usize,
    option: &str,
) -> Result<String, CliParseError> {
    *index += 1;
    args.get(*index)
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| CliParseError::MissingValue {
            option: option.to_owned(),
        })
}

fn next_path(args: &[OsString], index: &mut usize, option: &str) -> Result<PathBuf, CliParseError> {
    *index += 1;
    let value = args
        .get(*index)
        .ok_or_else(|| CliParseError::MissingValue {
            option: option.to_owned(),
        })?;
    if value.to_str().is_none() {
        return Err(CliParseError::NonUnicodeHostPath);
    }
    Ok(PathBuf::from(value))
}

fn require_no_args(command: &str, args: &[OsString]) -> Result<(), CliParseError> {
    let Some(argument) = args.first() else {
        return Ok(());
    };
    Err(CliParseError::UnexpectedArgument {
        command: command.to_owned(),
        argument: argument.to_string_lossy().into_owned(),
    })
}

fn render_registration(verb: &str, report: &RegistrationReport) -> String {
    let mut output = String::new();
    for result in &report.results {
        let description = match &result.outcome {
            ManifestOutcome::Registered => "manifest created".to_owned(),
            ManifestOutcome::Replaced => "owned manifest replaced".to_owned(),
            ManifestOutcome::Unregistered => "manifest removed".to_owned(),
            ManifestOutcome::Absent => "manifest already absent".to_owned(),
            ManifestOutcome::Unsupported { instruction } => instruction.clone(),
            ManifestOutcome::Failed { message } => message.clone(),
        };
        let marker = if result.outcome.is_success() {
            "ok"
        } else {
            "error"
        };
        let _ = writeln!(
            output,
            "[{marker}] {verb} {} {} registration at {}: {description}",
            result.browser.display_name(),
            report.scope,
            result.manifest_path.display(),
        );
    }
    output
}

fn render_doctor(report: &DoctorReport, format: DoctorFormat) -> CliOutput {
    let output = match format {
        DoctorFormat::Text => {
            let mut output = String::new();
            for finding in &report.findings {
                let target = finding.target.as_ref().map_or_else(String::new, |target| {
                    format!(
                        " {} {} ({})",
                        target.browser.display_name(),
                        target.scope,
                        target.manifest_path.display()
                    )
                });
                let _ = writeln!(
                    output,
                    "[{}] {}{target}: {}",
                    diagnostic_status_name(finding.status),
                    finding.check,
                    finding.message
                );
            }
            for step in &report.next_steps {
                let _ = writeln!(output, "next: {step}");
            }
            output
        }
        DoctorFormat::Json => format!("{}\n", doctor_json(report)),
    };
    if report.is_healthy() {
        CliOutput::success(output)
    } else {
        CliOutput::failure(output)
    }
}

fn doctor_json(report: &DoctorReport) -> Value {
    json!({
        "generatedAtUnixMs": report.generated_at_unix_ms,
        "ok": report.is_healthy(),
        "findings": report.findings.iter().map(|finding| json!({
            "check": finding.check,
            "status": diagnostic_status_name(finding.status),
            "message": finding.message,
            "target": finding.target.as_ref().map(|target| json!({
                "browser": target.browser.as_str(),
                "scope": target.scope.to_string(),
                "manifestPath": target.manifest_path,
            })),
        })).collect::<Vec<_>>(),
        "nextSteps": report.next_steps,
    })
}

/// Renders a parsed report in JSON for callers that need a structured transport.
#[must_use]
pub fn registration_json(report: &RegistrationReport) -> Value {
    json!({
        "scope": report.scope.to_string(),
        "ok": report.is_success(),
        "results": report.results.iter().map(|result| json!({
            "browser": result.browser.as_str(),
            "manifestPath": result.manifest_path,
            "outcome": match &result.outcome {
                ManifestOutcome::Registered => json!({"kind": "registered"}),
                ManifestOutcome::Replaced => json!({"kind": "replaced"}),
                ManifestOutcome::Unregistered => json!({"kind": "unregistered"}),
                ManifestOutcome::Absent => json!({"kind": "absent"}),
                ManifestOutcome::Unsupported { instruction } => json!({"kind": "unsupported", "instruction": instruction}),
                ManifestOutcome::Failed { message } => json!({"kind": "failed", "message": message}),
            },
        })).collect::<Vec<_>>(),
    })
}

/// Returns the stable command help including explicit integration boundaries.
#[must_use]
pub const fn help_text() -> &'static str {
    "HumanChrome native CLI\n\
\n\
Usage:\n\
  humanchrome-native install [--host-path <absolute-native-host>] [--browser chrome|chromium|all] [--detect] [--system] [--force]\n\
  humanchrome-native register [--host-path <absolute-native-host>] [--browser chrome|chromium|all] [--detect] [--system] [--force]\n\
  humanchrome-native unregister [--host-path <absolute-native-host>] [--browser chrome|chromium|all] [--system]\n\
  humanchrome-native fix-permissions [--host-path <native-host>]\n\
  humanchrome-native update-port <port> [--config <stdio-config.json>]\n\
  humanchrome-native doctor [--fix] [--host-path <absolute-native-host>] [--browser chrome|chromium|all] [--user|--system|--all-scopes] [--json]\n\
  humanchrome-native report [--json] [--output <file>] [--copy] [--no-redact] [--include-logs none|tail|full] [--log-lines <n>] [--browser chrome|chromium|all]\n\
  humanchrome-native fleet init|status|up|down|start|stop|restart ...\n\
  humanchrome-native fleet profile add|rm|ls|verify|enable|disable ...\n\
  humanchrome-native fleet worker init|serve|install-agent|uninstall-agent ...\n\
  humanchrome-native fleet worker init <id> --root <root> --host <tailscale-host> [--chrome-path <executable>] [--extension-dir <keyed-build>]\n\
  humanchrome-native fleet gateway serve|install-agent|uninstall-agent ...\n\
  humanchrome-native fleet coordinator --config <coordinator.json>\n\
  humanchrome-native help\n\
  humanchrome-native version\n\
\n\
`--detect` probes the current platform and falls back to both supported browsers when neither is installed.\n\
`register` and `install` stage the complete sibling native bundle by default; `--host-path` is an explicit direct-registration escape hatch for development and isolated profiles.\n\
System registration requires verified administrator privileges.\n\
Worker browser overrides are canonicalized before enrollment; installed-path defaults are unchanged.\n\
Launchd installation and removal require explicit --allow-agent-install.\n"
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, fs};

    use tempfile::tempdir;

    use super::{CliCommand, execute, parse_args};
    use crate::cli::{
        paths::{HostPlatform, NativeMessagingPaths},
        registration::{RegistrationContext, SystemInstallAuthorization},
    };

    #[test]
    fn parses_registration_without_process_state() {
        let command = parse_args(&[
            OsString::from("register"),
            OsString::from("--host-path"),
            OsString::from("/opt/humanchrome/native-host"),
            OsString::from("--browser"),
            OsString::from("chromium"),
            OsString::from("--force"),
        ])
        .expect("parse registration");
        assert!(matches!(command, CliCommand::Register(_)));
    }

    #[test]
    fn report_handler_collects_a_real_diagnostic_document() {
        let command = parse_args(&[OsString::from("report"), OsString::from("--json")])
            .expect("parse report");
        let root = tempdir().expect("temporary root");
        let context = RegistrationContext::new(
            NativeMessagingPaths::new(
                HostPlatform::Linux,
                root.path().join("home"),
                root.path().join("appdata"),
                root.path().join("system"),
            ),
            SystemInstallAuthorization::Verified,
        );
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let output = runtime.block_on(execute(&context, &command));
        assert_eq!(output.exit_code, 0, "{}", output.stderr);
        assert!(output.stdout.contains("\"schemaVersion\":1"));
    }

    #[test]
    fn registration_handler_writes_only_explicit_root() {
        let root = tempdir().expect("temporary root");
        let host = root.path().join("native-host");
        fs::write(&host, "#!/bin/sh\nexit 0\n").expect("write native host");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&host, fs::Permissions::from_mode(0o755)).expect("make executable");
        }
        let command = parse_args(&[
            OsString::from("register"),
            OsString::from("--host-path"),
            host.into_os_string(),
        ])
        .expect("parse registration");
        let context = RegistrationContext::new(
            NativeMessagingPaths::new(
                HostPlatform::Linux,
                root.path().join("home"),
                root.path().join("appdata"),
                root.path().join("system"),
            ),
            SystemInstallAuthorization::Verified,
        );
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let output = runtime.block_on(execute(&context, &command));
        assert_eq!(output.exit_code, 0, "{}", output.stderr);
        assert!(root
            .path()
            .join("home/.config/google-chrome/NativeMessagingHosts/com.humanchrome.nativehost.json")
            .exists());
    }
}
