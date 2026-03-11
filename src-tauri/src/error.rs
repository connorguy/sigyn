use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("the app is locked")]
    Locked,
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("failed to access the local store: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Crypto(String),
}
