use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct AppSnapshot {
    pub locked: bool,
    pub active_project_id: Option<String>,
    pub projects: Vec<ProjectRecord>,
}

impl AppSnapshot {
    pub fn locked() -> Self {
        Self {
            locked: true,
            active_project_id: None,
            projects: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub working_directory: Option<String>,
    pub supported_environments: Vec<String>,
    pub active_base_environment: String,
    pub entry_overrides: BTreeMap<String, String>,
    pub entries: Vec<EntryRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryRecord {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub description: Option<String>,
    pub values: Vec<EntryValueRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryValueRecord {
    pub environment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DecryptedEntryValue {
    pub environment: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewResult {
    pub project_id: String,
    pub project_name: String,
    pub preset_label: String,
    pub serialized: String,
    pub items: Vec<EffectiveEnvItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EffectiveEnvItem {
    pub entry_id: String,
    pub entry_name: String,
    pub source_environment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryValuesResult {
    pub entry_id: String,
    pub values: Vec<DecryptedEntryValue>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    #[serde(default)]
    pub supported_environments: Vec<String>,
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameProjectInput {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateProjectInput {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub supported_environments: Vec<String>,
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteProjectInput {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SelectProjectInput {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetBaseEnvironmentInput {
    pub project_id: String,
    pub environment: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResetOverridesInput {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetEntryOverrideInput {
    pub project_id: String,
    pub entry_id: String,
    pub environment: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateEntryInput {
    pub project_id: String,
    pub name: String,
    pub category: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub values: Vec<EntryValueInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateEntryInput {
    pub project_id: String,
    pub entry_id: String,
    pub name: String,
    pub category: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub values: Vec<EntryValueInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteEntryInput {
    pub project_id: String,
    pub entry_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewProjectInput {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetEntryValuesInput {
    pub project_id: String,
    pub entry_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EntryValueInput {
    pub environment: String,
    pub present: bool,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportEntriesInput {
    pub project_id: String,
    pub environment: String,
    pub entries: Vec<ImportEntryItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportEntryItem {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportEntriesResult {
    pub snapshot: AppSnapshot,
    pub created: usize,
    pub updated: usize,
}
