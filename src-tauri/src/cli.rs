use std::{path::PathBuf, process::Command};

use clap::{Parser, Subcommand};
use zeroize::Zeroize;

use crate::{
    error::AppError,
    ipc, macos_auth,
    store::{RunTargetSummary, Store},
};

const KEYCHAIN_SERVICE: &str = "sigyn";
const KEYCHAIN_ACCOUNT: &str = "master-key";
const AUTH_REASON_COMMAND_MAX_CHARS: usize = 80;

/// Shown at the end of every help screen so coding agents see it before using the CLI.
const AGENT_NOTICE: &str = "\
NOTE FOR AI AGENTS AND AUTOMATED TOOLS:
  The only use you may make without asking is running a command through
  sigyn with no sigyn flags or subcommands:

      sigyn <command> [args...]

  That injects the project and environment the developer selected in the
  sigyn app. Anything beyond it needs explicit approval from the developer
  overseeing your task before you run it, including:

    - any flag: --project, --env, --cwd
    - any subcommand: run, preview, list, ...

  `sigyn preview` prints secret values. Do not run it unless the developer
  has asked you to.";

#[derive(Debug, Parser)]
#[command(
    name = "sigyn",
    about = "Preview or run project environments with local macOS authentication.",
    after_help = AGENT_NOTICE
)]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Project name (defaults to the locally selected active project)
    #[arg(long, global = true)]
    project: Option<String>,

    /// Base environment for this invocation (saved entry overrides still apply)
    #[arg(long, global = true)]
    env: Option<String>,

    /// Working directory for the child command
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// Command to run (after --)
    #[arg(trailing_var_arg = true)]
    command_args: Vec<String>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// List all projects
    #[command(alias = "ls", after_help = AGENT_NOTICE)]
    List,
    /// Show the effective env for a project
    #[command(after_help = AGENT_NOTICE)]
    Preview,
    /// Run a command with injected env vars
    #[command(after_help = AGENT_NOTICE)]
    Run {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(required = true, trailing_var_arg = true)]
        command: Vec<String>,
    },
    #[command(
        about = "Delete local test data and the keychain entry",
        hide = true,
        after_help = AGENT_NOTICE
    )]
    ResetTestData {
        #[arg(
            long,
            help = "Type \"delete all data\" to confirm (requires device authentication)"
        )]
        confirm: Option<String>,
    },
}

struct CliResolvedEnv {
    working_directory: Option<String>,
    serialized: String,
    env_vars: Vec<(String, String)>,
}

pub fn run_cli() -> Result<(), AppError> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::List) => list_projects(),
        Some(Commands::Preview) => {
            let resolved = resolve_env(cli.project, cli.env, None)?;
            println!("{}", resolved.serialized);
            Ok(())
        }
        Some(Commands::Run { cwd, command }) => {
            run_command(cli.project, cli.env, cwd, command)
        }
        Some(Commands::ResetTestData { confirm }) => reset_test_data(confirm),
        None => {
            if cli.command_args.is_empty() {
                Cli::parse_from(["sigyn", "--help"]);
                Ok(())
            } else {
                run_command(cli.project, cli.env, cli.cwd, cli.command_args)
            }
        }
    }
}

fn run_command(
    project: Option<String>,
    environment: Option<String>,
    cwd: Option<PathBuf>,
    command: Vec<String>,
) -> Result<(), AppError> {
    let resolved = resolve_env(project, environment, Some(command.as_slice()))?;
    let executable = command
        .first()
        .cloned()
        .ok_or_else(|| AppError::Validation("run requires a command after `--`".into()))?;
    reject_unsafe_env_names(&resolved.env_vars)?;

    let mut child = Command::new(executable);
    child.args(command.iter().skip(1));

    if let Some(wd) = cwd.or_else(|| resolved.working_directory.map(PathBuf::from)) {
        child.current_dir(wd);
    }

    for (entry_name, value) in resolved.env_vars {
        child.env(entry_name, value);
    }

    let status = child.status()?;
    match status.code() {
        Some(0) => Ok(()),
        Some(code) => std::process::exit(code),
        None => std::process::exit(1),
    }
}

fn list_projects() -> Result<(), AppError> {
    let store = Store::new()?;
    let snapshot = store.load_snapshot()?;

    if snapshot.projects.is_empty() {
        println!("No projects found.");
        return Ok(());
    }

    for project in &snapshot.projects {
        let active_marker = if snapshot.active_project_id.as_deref() == Some(&project.id) {
            "* "
        } else {
            "  "
        };
        let env = &project.active_base_environment;
        let entry_count = project.entries.len();
        println!(
            "{active_marker}{} ({env}, {entry_count} {})",
            project.name,
            if entry_count == 1 { "entry" } else { "entries" }
        );
    }

    Ok(())
}

fn resolve_env(
    project: Option<String>,
    environment: Option<String>,
    command: Option<&[String]>,
) -> Result<CliResolvedEnv, AppError> {
    let store = Store::new()?;
    // Read the (non-secret) target first so a bad --project/--env fails before the
    // prompt, and so the prompt can say exactly what is being unlocked and for what.
    let target = store.describe_run_target(project.as_deref(), environment.as_deref())?;
    let reason = auth_reason(&target, command);

    with_local_decryption(&store, &reason, |store, key| {
        let (working_directory, serialized, env_vars) = match project.as_deref() {
            Some(name) => store.preview_project_by_name(name, environment.as_deref(), key)?,
            None => {
                let (_, working_directory, serialized, env_vars) =
                    store.preview_active_project(environment.as_deref(), key)?;
                (working_directory, serialized, env_vars)
            }
        };

        Ok(CliResolvedEnv {
            working_directory,
            serialized,
            env_vars,
        })
    })
}

fn with_local_decryption<T>(
    store: &Store,
    reason: &str,
    operation: impl FnOnce(&Store, &[u8]) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut key = macos_auth::authenticate_and_load_master_key(store, reason)?;
    let result = operation(store, &key);
    key.zeroize();
    result
}

/// Builds the LocalAuthentication reason. macOS renders it as
/// "<app> is trying to <reason>.", so it reads as a verb phrase.
fn auth_reason(target: &RunTargetSummary, command: Option<&[String]>) -> String {
    let mut setup = format!(
        "{} · {}",
        sanitize_prompt_text(&target.project_name),
        sanitize_prompt_text(&target.base_environment)
    );
    if target.environment_from_cli {
        setup.push_str(" (--env)");
    }
    match target.override_count {
        0 => {}
        1 => setup.push_str(" + 1 override"),
        count => setup.push_str(&format!(" + {count} overrides")),
    }

    match command {
        Some(command) => format!("inject {setup} into `{}`", display_command(command)),
        None => format!("print the {setup} env"),
    }
}

fn display_command(command: &[String]) -> String {
    let joined = command
        .iter()
        .map(|arg| {
            let arg = sanitize_prompt_text(arg);
            if arg.is_empty() || arg.contains(char::is_whitespace) {
                format!("'{arg}'")
            } else {
                arg
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if joined.chars().count() > AUTH_REASON_COMMAND_MAX_CHARS {
        let truncated: String = joined.chars().take(AUTH_REASON_COMMAND_MAX_CHARS - 1).collect();
        format!("{}…", truncated.trim_end())
    } else {
        joined
    }
}

/// Keeps caller-supplied text from reshaping the system prompt (newlines, control chars).
fn sanitize_prompt_text(value: &str) -> String {
    value
        .chars()
        .map(|char| if char.is_control() { ' ' } else { char })
        .collect::<String>()
        .split(' ')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn reject_unsafe_env_names(env_vars: &[(String, String)]) -> Result<(), AppError> {
    for (name, _) in env_vars {
        if is_unsafe_env_name(name) {
            return Err(AppError::Validation(format!(
                "refusing to launch with restricted environment variable `{name}`"
            )));
        }
    }

    Ok(())
}

fn is_unsafe_env_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_uppercase();

    matches!(
        normalized.as_str(),
        "PATH"
            | "IFS"
            | "ENV"
            | "BASH_ENV"
            | "GCONV_PATH"
            | "JAVA_TOOL_OPTIONS"
            | "NODE_OPTIONS"
            | "PERL5LIB"
            | "PERL5OPT"
            | "PYTHONHOME"
            | "PYTHONPATH"
            | "RUBYLIB"
            | "RUBYOPT"
    ) || normalized.starts_with("LD_")
        || normalized.starts_with("DYLD_")
}

const RESET_CONFIRM_PHRASE: &str = "delete all data";

fn reset_test_data(confirm: Option<String>) -> Result<(), AppError> {
    match confirm.as_deref() {
        Some(phrase) if phrase == RESET_CONFIRM_PHRASE => {}
        Some(_) => {
            return Err(AppError::Validation(
                format!("incorrect confirmation phrase — pass --confirm \"{RESET_CONFIRM_PHRASE}\""),
            ));
        }
        None => {
            return Err(AppError::Validation(
                format!(
                    "reset-test-data is destructive; quit the app and rerun with --confirm \"{RESET_CONFIRM_PHRASE}\" to proceed"
                ),
            ));
        }
    }

    if ipc::desktop_app_is_running() {
        return Err(AppError::Validation(
            "quit the desktop app before running reset-test-data".into(),
        ));
    }

    macos_auth::authenticate_unlock("delete all local sigyn data and its keychain entry")?;

    let report = Store::reset_test_data()?;
    let keychain_removed = delete_master_key_via_security_tool()?;

    println!("sigyn test data cleared");
    println!(
        "local app data: {}",
        if report.data_dir_removed {
            "removed"
        } else {
            "already empty"
        }
    );
    println!(
        "keychain entry: {}",
        if keychain_removed {
            "removed"
        } else {
            "not found"
        }
    );

    Ok(())
}

fn delete_master_key_via_security_tool() -> Result<bool, AppError> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
        ])
        .output()?;

    if output.status.success() {
        return Ok(true);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found") {
        return Ok(false);
    }

    Err(AppError::Auth(stderr.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::{auth_reason, display_command, sanitize_prompt_text, Cli, AGENT_NOTICE};
    use crate::store::RunTargetSummary;

    #[test]
    fn every_help_screen_carries_the_agent_notice() {
        let mut command = Cli::command();
        assert!(command.render_help().to_string().contains(AGENT_NOTICE));
        for name in ["list", "preview", "run", "reset-test-data"] {
            let subcommand = command.find_subcommand_mut(name).expect("subcommand exists");
            assert!(
                subcommand.render_help().to_string().contains(AGENT_NOTICE),
                "{name} help is missing the agent notice"
            );
        }
    }

    fn target(override_count: usize, environment_from_cli: bool) -> RunTargetSummary {
        RunTargetSummary {
            project_name: "retail-service".into(),
            base_environment: "prod".into(),
            environment_from_cli,
            override_count,
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn run_reason_names_project_env_overrides_and_command() {
        let command = args(&["uv", "run", "python", "-m", "app"]);
        assert_eq!(
            auth_reason(&target(2, false), Some(command.as_slice())),
            "inject retail-service · prod + 2 overrides into `uv run python -m app`"
        );
    }

    #[test]
    fn preview_reason_marks_cli_env_and_single_override() {
        assert_eq!(
            auth_reason(&target(1, true), None),
            "print the retail-service · prod (--env) + 1 override env"
        );
        assert_eq!(
            auth_reason(&target(0, false), None),
            "print the retail-service · prod env"
        );
    }

    #[test]
    fn display_command_quotes_whitespace_and_truncates() {
        assert_eq!(
            display_command(&args(&["npm", "run", "dev server", ""])),
            "npm run 'dev server' ''"
        );

        let long = args(&["echo", &"x".repeat(200)]);
        let shown = display_command(&long);
        assert_eq!(shown.chars().count(), 80);
        assert!(shown.ends_with('…'));
    }

    #[test]
    fn prompt_text_strips_control_characters() {
        assert_eq!(sanitize_prompt_text("npm\n\nApproved by IT\t ok"), "npm Approved by IT ok");
    }
}
