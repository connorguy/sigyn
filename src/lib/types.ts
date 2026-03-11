export type AppSnapshot = {
  locked: boolean
  active_project_id: string | null
  projects: ProjectRecord[]
}

export type ProjectRecord = {
  id: string
  name: string
  working_directory: string | null
  supported_environments: string[]
  active_base_environment: string
  entry_overrides: Record<string, string>
  entries: EntryRecord[]
}

export type EntryRecord = {
  id: string
  name: string
  category: string | null
  description: string | null
  values: EntryValueRecord[]
}

export type EntryValueRecord = {
  environment: string
}

export type DecryptedEntryValue = {
  environment: string
  value: string
}

export type EntryValuesResult = {
  entry_id: string
  values: DecryptedEntryValue[]
}

export type EffectiveEnvItem = {
  entry_id: string
  entry_name: string
  source_environment: string
}

export type PreviewResult = {
  project_id: string
  project_name: string
  preset_label: string
  serialized: string
  items: EffectiveEnvItem[]
}

export type CreateProjectInput = {
  name: string
  supported_environments: string[]
  working_directory: string | null
}

export type UpdateProjectInput = CreateProjectInput & {
  project_id: string
}

export type EntryValueInput = {
  environment: string
  present: boolean
  value: string
}

export type CreateEntryInput = {
  project_id: string
  name: string
  category: string | null
  description: string | null
  values: EntryValueInput[]
}

export type UpdateEntryInput = CreateEntryInput & {
  entry_id: string
}

export type ImportEntryItem = {
  name: string
  value: string
}

export type ImportEntriesInput = {
  project_id: string
  environment: string
  entries: ImportEntryItem[]
}

export type ImportEntriesResult = {
  snapshot: AppSnapshot
  created: number
  updated: number
}
