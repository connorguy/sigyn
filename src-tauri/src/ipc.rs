use std::{
    fs,
    io::{Read, Write},
    net::Shutdown,
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::{error::AppError, store::Store};

const SOCKET_FILENAME: &str = "cli.sock";
const MAX_REQUEST_SIZE: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize, Deserialize)]
enum Request {
    Ping,
}

#[derive(Debug, Serialize, Deserialize)]
enum Response {
    Pong,
}

pub fn start_server<R: Runtime>(_app: &AppHandle<R>) -> Result<(), AppError> {
    let socket_path = socket_path()?;
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }

    let listener = UnixListener::bind(&socket_path)?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;

    thread::Builder::new()
        .name("sigyn-cli-ipc".into())
        .spawn(move || serve(listener, socket_path))
        .map(|_| ())
        .map_err(Into::into)
}

pub fn desktop_app_is_running() -> bool {
    matches!(send_request(&Request::Ping), Ok(Response::Pong))
}

fn serve(listener: UnixListener, socket_path: PathBuf) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(err) = handle_connection(stream) {
                    eprintln!("sigyn CLI bridge error: {err}");
                }
            }
            Err(err) => {
                eprintln!("sigyn CLI bridge stopped: {err}");
                break;
            }
        }
    }

    let _ = fs::remove_file(socket_path);
}

fn handle_connection(mut stream: UnixStream) -> Result<(), AppError> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;

    let mut payload = Vec::with_capacity(256);
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if payload.len() + n > MAX_REQUEST_SIZE {
                    return Err(AppError::Validation("IPC request too large".into()));
                }
                payload.extend_from_slice(&buf[..n]);
            }
            Err(ref err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                return Err(AppError::Validation("IPC read timed out".into()));
            }
            Err(err) => return Err(err.into()),
        }
    }
    if payload.is_empty() {
        return Ok(());
    }

    let request: Request = serde_json::from_slice(&payload)?;
    let response = match request {
        Request::Ping => Response::Pong,
    };

    let encoded = serde_json::to_vec(&response)?;
    stream.write_all(&encoded)?;
    Ok(())
}

fn send_request(request: &Request) -> Result<Response, AppError> {
    let socket_path = socket_path()?;
    let mut stream = UnixStream::connect(&socket_path).map_err(map_connect_error)?;
    let encoded = serde_json::to_vec(request)?;
    stream.write_all(&encoded)?;
    stream.shutdown(Shutdown::Write)?;

    let mut payload = Vec::new();
    stream.read_to_end(&mut payload)?;
    serde_json::from_slice(&payload).map_err(Into::into)
}

fn socket_path() -> Result<PathBuf, AppError> {
    Ok(Store::data_dir_path()?.join(SOCKET_FILENAME))
}

fn map_connect_error(error: std::io::Error) -> AppError {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => AppError::Validation(
            "desktop app is not running — open sigyn and unlock it before using the CLI".into(),
        ),
        _ => AppError::Io(error),
    }
}
