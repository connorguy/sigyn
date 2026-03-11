use std::{path::PathBuf, process::Command};

use clap::{Parser, Subcommand};
use zeroize::Zeroize;

use crate::{error::AppError, ipc, macos_auth, store::Store};

const KEYCHAIN_SERVICE: &str = "sigyn";
const KEYCHAIN_ACCOUNT: &str = "master-key";

#[derive(Debug, Parser)]
#[command(
    name = "sigyn",
    about = "Preview or run project environments with local macOS authentication."
)]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Project name (defaults to the locally selected active project)
    #[arg(long, global = true)]
    project: Option<String>,

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
    #[command(alias = "ls")]
    List,
    /// Show the effective env for a project
    Preview,
    /// Run a command with injected env vars
    Run {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(required = true, trailing_var_arg = true)]
        command: Vec<String>,
    },
    #[command(
        about = "Delete local test data and the keychain entry",
        hide = true
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
            let resolved = resolve_env(cli.project)?;
            println!("{}", resolved.serialized);
            Ok(())
        }
        Some(Commands::Run { cwd, command }) => {
            run_command(cli.project, cwd, command)
        }
        Some(Commands::ResetTestData { confirm }) => reset_test_data(confirm),
        None => {
            if cli.command_args.is_empty() {
                Cli::parse_from(["sigyn", "--help"]);
                Ok(())
            } else {
                run_command(cli.project, cli.cwd, cli.command_args)
            }
        }
    }
}

fn run_command(
    project: Option<String>,
    cwd: Option<PathBuf>,
    command: Vec<String>,
) -> Result<(), AppError> {
    let resolved = resolve_env(project)?;
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

fn resolve_env(project: Option<String>) -> Result<CliResolvedEnv, AppError> {
    with_local_decryption(|store, key| {
        let (working_directory, serialized, env_vars) = match project.as_deref() {
            Some(name) => store.preview_project_by_name(name, key)?,
            None => {
                let (_, working_directory, serialized, env_vars) = store.preview_active_project(key)?;
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
    operation: impl FnOnce(&Store, &[u8]) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let store = Store::new()?;
    let mut key = macos_auth::authenticate_and_load_master_key(&store)?;
    let result = operation(&store, &key);
    key.zeroize();
    result
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

    macos_auth::authenticate_unlock()?;

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
