import { invoke } from "@tauri-apps/api/core"

import type {
  AppSnapshot,
  CreateEntryInput,
  CreateProjectInput,
  EntryValuesResult,
  ImportEntriesInput,
  ImportEntriesResult,
  PreviewResult,
  UpdateProjectInput,
  UpdateEntryInput,
} from "./types"

export function getSnapshot() {
  return invoke<AppSnapshot>("get_snapshot")
}

export function unlockApp() {
  return invoke<AppSnapshot>("unlock_app")
}

export function lockApp() {
  return invoke<AppSnapshot>("lock_app")
}

export function touchSession() {
  return invoke<void>("touch_session")
}

export function createProject(input: CreateProjectInput) {
  return invoke<AppSnapshot>("create_project", { input })
}

export function renameProject(project_id: string, name: string) {
  return invoke<AppSnapshot>("rename_project", {
    input: { project_id, name },
  })
}

export function updateProject(input: UpdateProjectInput) {
  return invoke<AppSnapshot>("update_project", { input })
}

export function deleteProject(project_id: string) {
  return invoke<AppSnapshot>("delete_project", {
    input: { project_id },
  })
}

export function selectProject(project_id: string) {
  return invoke<AppSnapshot>("select_project", {
    input: { project_id },
  })
}

export function setBaseEnvironment(project_id: string, environment: string) {
  return invoke<AppSnapshot>("set_base_environment", {
    input: { project_id, environment },
  })
}

export function resetOverrides(project_id: string) {
  return invoke<AppSnapshot>("reset_overrides", {
    input: { project_id },
  })
}

export function setEntryOverride(
  project_id: string,
  entry_id: string,
  environment: string | null,
) {
  return invoke<AppSnapshot>("set_entry_override", {
    input: { project_id, entry_id, environment },
  })
}

export function createEntry(input: CreateEntryInput) {
  return invoke<AppSnapshot>("create_entry", { input })
}

export function updateEntry(input: UpdateEntryInput) {
  return invoke<AppSnapshot>("update_entry", { input })
}

export function deleteEntry(project_id: string, entry_id: string) {
  return invoke<AppSnapshot>("delete_entry", {
    input: { project_id, entry_id },
  })
}

export function importEntries(input: ImportEntriesInput) {
  return invoke<ImportEntriesResult>("import_entries", { input })
}

export function previewProject(project_id: string) {
  return invoke<PreviewResult>("preview_project", {
    input: { project_id },
  })
}

export function getEntryValues(project_id: string, entry_id: string) {
  return invoke<EntryValuesResult>("get_entry_values", {
    input: { project_id, entry_id },
  })
}
