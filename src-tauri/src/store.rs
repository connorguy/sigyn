use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
};

use aes_gcm_siv::{
    aead::{Aead, KeyInit},
    Aes256GcmSiv, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use directories::ProjectDirs;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use uuid::Uuid;

use crate::{
    error::AppError,
    model::{
        AppSnapshot, CreateEntryInput, CreateProjectInput, DecryptedEntryValue, DeleteEntryInput,
        DeleteProjectInput, EffectiveEnvItem, EntryRecord, EntryValueInput, EntryValueRecord,
        EntryValuesResult, ImportEntriesInput, ImportEntriesResult, PreviewResult, ProjectRecord,
        RenameProjectInput, ResetOverridesInput, SelectProjectInput, SetBaseEnvironmentInput,
        SetEntryOverrideInput, UpdateEntryInput, UpdateProjectInput,
    },
};

const APP_QUALIFIER: &str = "com";
const APP_ORGANIZATION: &str = "connorguy";
const APP_NAME: &str = "sigyn";
const DB_FILENAME: &str = "sigyn.sqlite3";
const ACTIVE_PROJECT_KEY: &str = "active_project_id";

struct ResolvedEffectiveEnvItem {
    entry_id: String,
    entry_name: String,
    source_environment: String,
    value: String,
}

struct ResolvedPreview {
    project_id: String,
    project_name: String,
    preset_label: String,
    serialized: String,
    items: Vec<ResolvedEffectiveEnvItem>,
}

impl ResolvedPreview {
    fn into_public(self) -> PreviewResult {
        PreviewResult {
            project_id: self.project_id,
            project_name: self.project_name,
            preset_label: self.preset_label,
            serialized: self.serialized,
            items: self
                .items
                .into_iter()
                .map(|item| EffectiveEnvItem {
                    entry_id: item.entry_id,
                    entry_name: item.entry_name,
                    source_environment: item.source_environment,
                })
                .collect(),
        }
    }
}

pub struct Store {
    db_path: PathBuf,
}

pub struct ResetDataReport {
    pub data_dir_removed: bool,
}

impl Store {
    pub fn new() -> Result<Self, AppError> {
        let data_dir = Self::data_dir()?;
        fs::create_dir_all(&data_dir)?;
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700))?;
        let db_path = data_dir.join(DB_FILENAME);

        let store = Self { db_path };
        store.init_schema()?;

        // Harden database file permissions after schema init creates/opens it.
        if store.db_path.exists() {
            fs::set_permissions(&store.db_path, fs::Permissions::from_mode(0o600))?;
        }

        Ok(store)
    }

    pub fn reset_test_data() -> Result<ResetDataReport, AppError> {
        let data_dir = Self::data_dir()?;
        let data_dir_removed = if data_dir.exists() {
            fs::remove_dir_all(&data_dir)?;
            true
        } else {
            false
        };

        Ok(ResetDataReport { data_dir_removed })
    }

    pub fn data_dir_path() -> Result<PathBuf, AppError> {
        Self::data_dir()
    }

    pub fn has_encrypted_entries(&self) -> Result<bool, AppError> {
        let conn = self.connection()?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM entry_values", [], |row| row.get(0))?;
        Ok(count > 0)
    }

    pub fn load_snapshot(&self) -> Result<AppSnapshot, AppError> {
        let conn = self.connection()?;
        let (active_project_id, mut projects) = self.load_projects_metadata(&conn)?;

        for project in &mut projects {
            project.entries = self.load_entries(&conn, &project.id)?;
            project.entries.sort_by(|left, right| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            });
        }

        Ok(AppSnapshot {
            locked: false,
            active_project_id,
            projects,
        })
    }

    pub fn load_locked_snapshot(&self) -> Result<AppSnapshot, AppError> {
        let conn = self.connection()?;
        let (active_project_id, projects) = self.load_projects_metadata(&conn)?;
        Ok(AppSnapshot {
            locked: true,
            active_project_id,
            projects,
        })
    }

    fn load_projects_metadata(
        &self,
        conn: &Connection,
    ) -> Result<(Option<String>, Vec<ProjectRecord>), AppError> {
        let selected_active = self.read_app_state(conn, ACTIVE_PROJECT_KEY)?;

        let mut projects = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT id, name, working_directory, supported_environments, base_environment
             FROM projects
             ORDER BY name COLLATE NOCASE",
        )?;
        let project_rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        for (id, name, working_directory, supported_environments, base_environment) in
            project_rows
        {
            projects.push(ProjectRecord {
                id: id.clone(),
                name,
                working_directory,
                supported_environments: serde_json::from_str(&supported_environments)?,
                active_base_environment: base_environment,
                entry_overrides: self.load_entry_overrides(conn, &id)?,
                entries: Vec::new(),
            });
        }

        let active_project_id = selected_active
            .filter(|active_id| projects.iter().any(|project| &project.id == active_id))
            .or_else(|| projects.first().map(|project| project.id.clone()));

        Ok((active_project_id, projects))
    }

    pub fn create_project(&self, input: CreateProjectInput) -> Result<AppSnapshot, AppError> {
        let name = normalize_project_name(&input.name)?;
        let supported_environments =
            normalize_supported_environments(input.supported_environments)?;
        let working_directory = normalize_optional_text(input.working_directory);
        let base_environment = supported_environments.first().cloned().ok_or_else(|| {
            AppError::Validation("projects must define at least one environment".into())
        })?;
        let project_id = Uuid::new_v4().to_string();

        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO projects (id, name, working_directory, supported_environments, base_environment)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project_id,
                name,
                working_directory,
                serde_json::to_string(&supported_environments)?,
                base_environment,
            ],
        )?;
        self.write_app_state(&tx, ACTIVE_PROJECT_KEY, &project_id)?;
        tx.commit()?;

        self.load_snapshot()
    }

    pub fn rename_project(&self, input: RenameProjectInput) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![normalize_project_name(&input.name)?, input.project_id],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound("project not found".into()));
        }
        tx.commit()?;
        self.load_snapshot()
    }

    pub fn update_project(&self, input: UpdateProjectInput) -> Result<AppSnapshot, AppError> {
        let name = normalize_project_name(&input.name)?;
        let supported_environments =
            normalize_supported_environments(input.supported_environments)?;
        let working_directory = normalize_optional_text(input.working_directory);

        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let existing_environments = self.project_environments(&tx, &input.project_id)?;
        for environment in &existing_environments {
            if !supported_environments.contains(environment) {
                return Err(AppError::Validation(format!(
                    "removing supported environment `{environment}` is not supported yet"
                )));
            }
        }

        let updated = tx.execute(
            "UPDATE projects
             SET name = ?1,
                 working_directory = ?2,
                 supported_environments = ?3
             WHERE id = ?4",
            params![
                name,
                working_directory,
                serde_json::to_string(&supported_environments)?,
                input.project_id,
            ],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound("project not found".into()));
        }

        tx.commit()?;
        self.load_snapshot()
    }

    pub fn delete_project(&self, input: DeleteProjectInput) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let selected_active = tx
            .query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                params![ACTIVE_PROJECT_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let deleted = tx.execute("DELETE FROM projects WHERE id = ?1", params![input.project_id])?;
        if deleted == 0 {
            return Err(AppError::NotFound("project not found".into()));
        }

        if selected_active.as_deref() == Some(input.project_id.as_str()) {
            let next_project_id = tx
                .query_row(
                    "SELECT id FROM projects ORDER BY name COLLATE NOCASE LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            if let Some(project_id) = next_project_id {
                self.write_app_state(&tx, ACTIVE_PROJECT_KEY, &project_id)?;
            } else {
                self.clear_app_state(&tx, ACTIVE_PROJECT_KEY)?;
            }
        }

        tx.commit()?;
        self.load_snapshot()
    }

    pub fn select_project(&self, input: SelectProjectInput) -> Result<AppSnapshot, AppError> {
        let conn = self.connection()?;
        let exists = conn
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1",
                params![input.project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(AppError::NotFound("project not found".into()));
        }

        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        self.write_app_state(&tx, ACTIVE_PROJECT_KEY, &input.project_id)?;
        tx.commit()?;

        self.load_snapshot()
    }

    pub fn set_base_environment(
        &self,
        input: SetBaseEnvironmentInput,
    ) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let supported = self.project_environments(&tx, &input.project_id)?;
        let environment = normalize_environment_name(&input.environment)?;
        if !supported.contains(&environment) {
            return Err(AppError::Validation(format!(
                "environment `{environment}` is not supported by this project"
            )));
        }

        let updated = tx.execute(
            "UPDATE projects SET base_environment = ?1 WHERE id = ?2",
            params![environment, input.project_id],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound("project not found".into()));
        }
        tx.execute(
            "DELETE FROM entry_overrides WHERE project_id = ?1",
            params![input.project_id],
        )?;
        tx.commit()?;

        self.load_snapshot()
    }

    pub fn reset_overrides(&self, input: ResetOverridesInput) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM entry_overrides WHERE project_id = ?1",
            params![input.project_id],
        )?;
        tx.commit()?;
        self.load_snapshot()
    }

    pub fn create_entry(
        &self,
        input: CreateEntryInput,
        key: &[u8],
    ) -> Result<AppSnapshot, AppError> {
        let entry_id = Uuid::new_v4().to_string();
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let project_environments = self.project_environments(&tx, &input.project_id)?;
        let values = normalize_entry_values(input.values, &project_environments)?;

        tx.execute(
            "INSERT INTO entries (id, project_id, name, category, description)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                entry_id,
                input.project_id,
                normalize_entry_name(&input.name)?,
                normalize_optional_text(input.category),
                normalize_optional_text(input.description),
            ],
        )?;

        self.replace_entry_values(&tx, &entry_id, &values, key)?;
        tx.commit()?;

        self.load_snapshot()
    }

    pub fn update_entry(
        &self,
        input: UpdateEntryInput,
        key: &[u8],
    ) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let project_environments = self.project_environments(&tx, &input.project_id)?;
        let values = normalize_entry_values(input.values, &project_environments)?;

        let entry_project_id = tx
            .query_row(
                "SELECT project_id FROM entries WHERE id = ?1",
                params![input.entry_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("entry not found".into()))?;
        if entry_project_id != input.project_id {
            return Err(AppError::Validation(
                "entry does not belong to the selected project".into(),
            ));
        }

        tx.execute(
            "UPDATE entries
             SET name = ?1, category = ?2, description = ?3
             WHERE id = ?4",
            params![
                normalize_entry_name(&input.name)?,
                normalize_optional_text(input.category),
                normalize_optional_text(input.description),
                input.entry_id,
            ],
        )?;

        self.replace_entry_values(&tx, &input.entry_id, &values, key)?;
        tx.commit()?;

        self.load_snapshot()
    }

    pub fn delete_entry(&self, input: DeleteEntryInput) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let deleted = tx.execute(
            "DELETE FROM entries WHERE id = ?1 AND project_id = ?2",
            params![input.entry_id, input.project_id],
        )?;
        if deleted == 0 {
            return Err(AppError::NotFound("entry not found".into()));
        }
        tx.commit()?;

        self.load_snapshot()
    }

    pub fn import_entries(
        &self,
        input: ImportEntriesInput,
        key: &[u8],
    ) -> Result<ImportEntriesResult, AppError> {
        let environment = normalize_environment_name(&input.environment)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;

        let supported = self.project_environments(&tx, &input.project_id)?;
        if !supported.contains(&environment) {
            return Err(AppError::Validation(format!(
                "environment `{environment}` is not supported by this project"
            )));
        }

        let mut created: usize = 0;
        let mut updated: usize = 0;

        for item in &input.entries {
            let name = match normalize_entry_name(&item.name) {
                Ok(n) => n,
                Err(_) => continue,
            };

            let existing_entry_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM entries WHERE project_id = ?1 AND name = ?2",
                    params![input.project_id, name],
                    |row| row.get(0),
                )
                .optional()?;

            match existing_entry_id {
                Some(entry_id) => {
                    tx.execute(
                        "INSERT INTO entry_values (entry_id, environment_name, encrypted_value)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(entry_id, environment_name)
                         DO UPDATE SET encrypted_value = excluded.encrypted_value",
                        params![entry_id, environment, encrypt_value(key, &item.value)?],
                    )?;
                    updated += 1;
                }
                None => {
                    let entry_id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO entries (id, project_id, name, category, description)
                         VALUES (?1, ?2, ?3, NULL, NULL)",
                        params![entry_id, input.project_id, name],
                    )?;
                    tx.execute(
                        "INSERT INTO entry_values (entry_id, environment_name, encrypted_value)
                         VALUES (?1, ?2, ?3)",
                        params![entry_id, environment, encrypt_value(key, &item.value)?],
                    )?;
                    created += 1;
                }
            }
        }

        tx.commit()?;
        let snapshot = self.load_snapshot()?;

        Ok(ImportEntriesResult {
            snapshot,
            created,
            updated,
        })
    }

    pub fn set_entry_override(
        &self,
        input: SetEntryOverrideInput,
    ) -> Result<AppSnapshot, AppError> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let supported = self.project_environments(&tx, &input.project_id)?;
        let base_environment = tx
            .query_row(
                "SELECT base_environment FROM projects WHERE id = ?1",
                params![input.project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("project not found".into()))?;
        let entry_exists = tx
            .query_row(
                "SELECT 1 FROM entries WHERE id = ?1 AND project_id = ?2",
                params![input.entry_id, input.project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !entry_exists {
            return Err(AppError::NotFound("entry not found".into()));
        }

        match input.environment {
            Some(environment) => {
                let environment = normalize_environment_name(&environment)?;
                if !supported.contains(&environment) {
                    return Err(AppError::Validation(format!(
                        "environment `{environment}` is not supported by this project"
                    )));
                }
                if environment == base_environment {
                    tx.execute(
                        "DELETE FROM entry_overrides WHERE project_id = ?1 AND entry_id = ?2",
                        params![input.project_id, input.entry_id],
                    )?;
                } else {
                    tx.execute(
                        "INSERT INTO entry_overrides (project_id, entry_id, environment_name)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(project_id, entry_id)
                         DO UPDATE SET environment_name = excluded.environment_name",
                        params![input.project_id, input.entry_id, environment],
                    )?;
                }
            }
            None => {
                tx.execute(
                    "DELETE FROM entry_overrides WHERE project_id = ?1 AND entry_id = ?2",
                    params![input.project_id, input.entry_id],
                )?;
            }
        }

        tx.commit()?;
        self.load_snapshot()
    }

    pub fn preview_project(&self, project_id: &str, key: &[u8]) -> Result<PreviewResult, AppError> {
        Ok(self.resolve_preview(project_id, key)?.into_public())
    }

    pub fn preview_project_by_name(
        &self,
        project_name: &str,
        key: &[u8],
    ) -> Result<(Option<String>, String, Vec<(String, String)>), AppError> {
        let conn = self.connection()?;
        let (project_id, working_directory): (String, Option<String>) = conn
            .query_row(
                "SELECT id, working_directory FROM projects WHERE name COLLATE NOCASE = ?1",
                params![project_name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("project `{project_name}` not found")))?;

        let ResolvedPreview {
            serialized, items, ..
        } = self.resolve_preview(&project_id, key)?;
        let env_vars = items
            .into_iter()
            .map(|item| (item.entry_name, item.value))
            .collect();
        Ok((working_directory, serialized, env_vars))
    }

    pub fn preview_active_project(
        &self,
        key: &[u8],
    ) -> Result<(String, Option<String>, String, Vec<(String, String)>), AppError> {
        let conn = self.connection()?;
        let project_id = self
            .read_app_state(&conn, ACTIVE_PROJECT_KEY)?
            .ok_or_else(|| {
                AppError::Validation(
                    "no active project selected — select a project in sigyn or pass --project"
                        .into(),
                )
            })?;

        let (name, working_directory): (String, Option<String>) = conn
            .query_row(
                "SELECT name, working_directory FROM projects WHERE id = ?1",
                params![project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::Validation(
                    "the previously selected project no longer exists — select a project in sigyn or pass --project"
                        .into(),
                )
            })?;

        let ResolvedPreview {
            serialized, items, ..
        } = self.resolve_preview(&project_id, key)?;
        let env_vars = items
            .into_iter()
            .map(|item| (item.entry_name, item.value))
            .collect();
        Ok((name, working_directory, serialized, env_vars))
    }

    pub fn get_entry_values(
        &self,
        project_id: &str,
        entry_id: &str,
        key: &[u8],
    ) -> Result<EntryValuesResult, AppError> {
        let conn = self.connection()?;

        let exists = conn
            .query_row(
                "SELECT 1 FROM entries WHERE id = ?1 AND project_id = ?2",
                params![entry_id, project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(AppError::NotFound("entry not found".into()));
        }

        let values = self.load_entry_values_decrypted(&conn, entry_id, key)?;
        Ok(EntryValuesResult {
            entry_id: entry_id.to_string(),
            values,
        })
    }

    fn resolve_preview(&self, project_id: &str, key: &[u8]) -> Result<ResolvedPreview, AppError> {
        let conn = self.connection()?;

        let (name, base_environment) = conn
            .query_row(
                "SELECT name, base_environment FROM projects WHERE id = ?1",
                params![project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("project not found".into()))?;

        let entry_overrides = self.load_entry_overrides(&conn, project_id)?;

        let mut stmt = conn.prepare(
            "SELECT id, name FROM entries WHERE project_id = ?1 ORDER BY name COLLATE NOCASE",
        )?;
        let entries: Vec<(String, String)> = stmt
            .query_map(params![project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut lines = Vec::new();
        let mut items = Vec::new();

        for (entry_id, entry_name) in &entries {
            let source_environment = entry_overrides
                .get(entry_id)
                .cloned()
                .unwrap_or_else(|| base_environment.clone());

            let encrypted: Option<String> = conn
                .query_row(
                    "SELECT encrypted_value FROM entry_values WHERE entry_id = ?1 AND environment_name = ?2",
                    params![entry_id, source_environment],
                    |row| row.get(0),
                )
                .optional()?;

            let value = match encrypted
                .map(|enc| decrypt_value(key, &enc))
                .transpose()?
            {
                Some(v) => v,
                None => {
                    eprintln!(
                        "warning: `{}` has no value for `{}`, skipping",
                        entry_name, source_environment
                    );
                    continue;
                }
            };

            lines.push(format!("{}={}", entry_name, serialize_env_value(&value)));
            items.push(ResolvedEffectiveEnvItem {
                entry_id: entry_id.clone(),
                entry_name: entry_name.clone(),
                source_environment,
                value,
            });
        }

        let preset_label = if entry_overrides.is_empty() {
            format!("all_{}", base_environment)
        } else {
            "custom".into()
        };

        Ok(ResolvedPreview {
            project_id: project_id.to_string(),
            project_name: name,
            preset_label,
            serialized: lines.join("\n"),
            items,
        })
    }

    fn init_schema(&self) -> Result<(), AppError> {
        let conn = self.connection()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                working_directory TEXT,
                supported_environments TEXT NOT NULL,
                base_environment TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT,
                description TEXT,
                UNIQUE(project_id, name)
            );

            CREATE TABLE IF NOT EXISTS entry_values (
                entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                environment_name TEXT NOT NULL,
                encrypted_value TEXT NOT NULL,
                PRIMARY KEY(entry_id, environment_name)
            );

            CREATE TABLE IF NOT EXISTS entry_overrides (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                environment_name TEXT NOT NULL,
                PRIMARY KEY(project_id, entry_id)
            );
            ",
        )?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection, AppError> {
        let conn = Connection::open(&self.db_path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    fn project_dirs() -> Result<ProjectDirs, AppError> {
        ProjectDirs::from(APP_QUALIFIER, APP_ORGANIZATION, APP_NAME).ok_or_else(|| {
            AppError::Validation("unable to resolve an application data directory".into())
        })
    }

    fn data_dir() -> Result<PathBuf, AppError> {
        Ok(Self::project_dirs()?.data_local_dir().to_path_buf())
    }

    fn load_entries(
        &self,
        conn: &Connection,
        project_id: &str,
    ) -> Result<Vec<EntryRecord>, AppError> {
        let mut entries = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT id, name, category, description
             FROM entries
             WHERE project_id = ?1
             ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        for (id, name, category, description) in rows {
            entries.push(EntryRecord {
                id: id.clone(),
                name,
                category,
                description,
                values: self.load_entry_values(conn, &id)?,
            });
        }

        Ok(entries)
    }

    fn load_entry_values(
        &self,
        conn: &Connection,
        entry_id: &str,
    ) -> Result<Vec<EntryValueRecord>, AppError> {
        let mut values = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT environment_name
             FROM entry_values
             WHERE entry_id = ?1
             ORDER BY environment_name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![entry_id], |row| row.get::<_, String>(0))?;

        for row in rows {
            values.push(EntryValueRecord { environment: row? });
        }

        Ok(values)
    }

    fn load_entry_values_decrypted(
        &self,
        conn: &Connection,
        entry_id: &str,
        key: &[u8],
    ) -> Result<Vec<DecryptedEntryValue>, AppError> {
        let mut values = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT environment_name, encrypted_value
             FROM entry_values
             WHERE entry_id = ?1
             ORDER BY environment_name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![entry_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (environment, encrypted_value) = row?;
            values.push(DecryptedEntryValue {
                environment,
                value: decrypt_value(key, &encrypted_value)?,
            });
        }

        Ok(values)
    }

    fn load_entry_overrides(
        &self,
        conn: &Connection,
        project_id: &str,
    ) -> Result<BTreeMap<String, String>, AppError> {
        let mut overrides = BTreeMap::new();
        let mut stmt = conn.prepare(
            "SELECT entry_id, environment_name
             FROM entry_overrides
             WHERE project_id = ?1",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (entry_id, environment_name) = row?;
            overrides.insert(entry_id, environment_name);
        }

        Ok(overrides)
    }

    fn project_environments(
        &self,
        tx: &Transaction<'_>,
        project_id: &str,
    ) -> Result<Vec<String>, AppError> {
        let encoded = tx
            .query_row(
                "SELECT supported_environments FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("project not found".into()))?;
        Ok(serde_json::from_str(&encoded)?)
    }

    fn replace_entry_values(
        &self,
        tx: &Transaction<'_>,
        entry_id: &str,
        values: &[(String, String)],
        key: &[u8],
    ) -> Result<(), AppError> {
        tx.execute(
            "DELETE FROM entry_values WHERE entry_id = ?1",
            params![entry_id],
        )?;
        for (environment, value) in values {
            tx.execute(
                "INSERT INTO entry_values (entry_id, environment_name, encrypted_value)
                 VALUES (?1, ?2, ?3)",
                params![entry_id, environment, encrypt_value(key, value)?],
            )?;
        }
        Ok(())
    }

    fn read_app_state(&self, conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
        conn.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(Into::into)
    }

    fn write_app_state(
        &self,
        tx: &Transaction<'_>,
        key: &str,
        value: &str,
    ) -> Result<(), AppError> {
        tx.execute(
            "INSERT INTO app_state (key, value)
             VALUES (?1, ?2)
             ON CONFLICT(key)
             DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    fn clear_app_state(&self, tx: &Transaction<'_>, key: &str) -> Result<(), AppError> {
        tx.execute("DELETE FROM app_state WHERE key = ?1", params![key])?;
        Ok(())
    }
}

fn normalize_project_name(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("project name cannot be empty".into()));
    }
    Ok(trimmed.to_string())
}

fn normalize_entry_name(value: &str) -> Result<String, AppError> {
    let normalized = value
        .trim()
        .chars()
        .map(|char| match char {
            'a'..='z' => char.to_ascii_uppercase(),
            'A'..='Z' | '0'..='9' => char,
            _ => '_',
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();

    if normalized.is_empty() {
        return Err(AppError::Validation(
            "entry names must contain letters or numbers".into(),
        ));
    }

    Ok(normalized)
}

fn normalize_environment_name(value: &str) -> Result<String, AppError> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .replace(' ', "-")
        .chars()
        .filter(|char| char.is_ascii_alphanumeric() || *char == '-' || *char == '_')
        .collect::<String>();

    if normalized.is_empty() {
        return Err(AppError::Validation(
            "environment labels cannot be empty".into(),
        ));
    }

    Ok(normalized)
}

fn normalize_supported_environments(values: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();

    for value in values {
        let environment = normalize_environment_name(&value)?;
        if seen.insert(environment.clone()) {
            normalized.push(environment);
        }
    }

    if normalized.is_empty() {
        return Err(AppError::Validation(
            "projects must define at least one environment".into(),
        ));
    }

    Ok(normalized)
}

fn normalize_entry_values(
    values: Vec<EntryValueInput>,
    project_environments: &[String],
) -> Result<Vec<(String, String)>, AppError> {
    let allowed = project_environments
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut deduped = BTreeMap::new();

    for value in values {
        let environment = normalize_environment_name(&value.environment)?;
        if !allowed.contains(&environment) {
            return Err(AppError::Validation(format!(
                "environment `{environment}` is not supported by this project"
            )));
        }
        if value.present {
            deduped.insert(environment, value.value);
        } else {
            deduped.remove(&environment);
        }
    }

    Ok(deduped.into_iter().collect())
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn encrypt_value(key: &[u8], plaintext: &str) -> Result<String, AppError> {
    let cipher = Aes256GcmSiv::new_from_slice(key)
        .map_err(|err| AppError::Crypto(format!("failed to initialize cipher: {err}")))?;
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|err| AppError::Crypto(format!("failed to encrypt value: {err}")))?;

    let mut payload = nonce_bytes.to_vec();
    payload.extend_from_slice(&ciphertext);

    Ok(STANDARD.encode(payload))
}

fn decrypt_value(key: &[u8], encoded: &str) -> Result<String, AppError> {
    let payload = STANDARD
        .decode(encoded)
        .map_err(|err| AppError::Crypto(format!("failed to decode encrypted value: {err}")))?;
    if payload.len() < 13 {
        return Err(AppError::Crypto(
            "encrypted value payload is too short".into(),
        ));
    }

    let (nonce_bytes, ciphertext) = payload.split_at(12);
    let cipher = Aes256GcmSiv::new_from_slice(key)
        .map_err(|err| AppError::Crypto(format!("failed to initialize cipher: {err}")))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|err| AppError::Crypto(format!("failed to decrypt value: {err}")))?;

    String::from_utf8(plaintext)
        .map_err(|err| AppError::Crypto(format!("decrypted value was not valid utf-8: {err}")))
}

fn serialize_env_value(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }

    if value.chars().all(|char| {
        char.is_ascii_alphanumeric() || matches!(char, '_' | '-' | '.' | '/' | ':' | '@')
    }) {
        return value.to_string();
    }

    let escaped = value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}
