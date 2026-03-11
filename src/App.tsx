import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { listen } from "@tauri-apps/api/event"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Shield,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react"

import appIcon from "@/assets/app-icon.png"
import {
  createEntry,
  createProject,
  deleteProject,
  deleteEntry,
  getEntryValues,
  getSnapshot,
  importEntries,
  lockApp,
  previewProject,
  renameProject,
  resetOverrides,
  selectProject,
  setBaseEnvironment,
  setEntryOverride,
  touchSession,
  unlockApp,
  updateProject,
  updateEntry,
} from "@/lib/api"
import type {
  AppSnapshot,
  CreateEntryInput,
  CreateProjectInput,
  EntryRecord,
  EntryValueInput,
  ImportEntryItem,
  PreviewResult,
  ProjectRecord,
  UpdateProjectInput,
  UpdateEntryInput,
} from "@/lib/types"

type ValueDraft = {
  present: boolean
  value: string
}

type BannerNotice = {
  tone: "success" | "warning"
  message: string
}

type ProjectFormValues = {
  name: string
  environmentText: string
  workingDirectory: string
}

type EntryDeleteTarget = {
  projectId: string
  entryId: string
  entryName: string
}

type ProjectDeleteTarget = {
  projectId: string
  projectName: string
}

const DEFAULT_ENVS = ["local", "dev", "staging", "prod"]
const IDLE_LOCK_MS = 5 * 60 * 1000
const SESSION_TOUCH_THROTTLE_MS = 60 * 1000
const CLIPBOARD_CLEAR_DELAY_MS = 60 * 1000
const SNAPSHOT_UPDATED_EVENT = "snapshot-updated"
const OBSCURED_SECRET_MASK = "••••••••"

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<BannerNotice | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showEditProject, setShowEditProject] = useState(false)
  const [showAddEntry, setShowAddEntry] = useState(false)
  const [showImportEntries, setShowImportEntries] = useState(false)
  const [isCliPanelExpanded, setIsCliPanelExpanded] = useState(false)
  const [isRenamingProject, setIsRenamingProject] = useState(false)
  const [projectNameDraft, setProjectNameDraft] = useState("")
  const [entryDeleteTarget, setEntryDeleteTarget] = useState<EntryDeleteTarget | null>(null)
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<ProjectDeleteTarget | null>(null)
  const autoLockInFlight = useRef(false)
  const lastSessionTouchAt = useRef(0)
  const sessionTouchInFlight = useRef(false)

  useEffect(() => {
    void loadInitialSnapshot()
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | null = null

    void listen<AppSnapshot>(SNAPSHOT_UPDATED_EVENT, (event) => {
      const next = event.payload
      if (next.locked) {
        resetTransientUi()
        lastSessionTouchAt.current = 0
        sessionTouchInFlight.current = false
      }
      setSnapshot(next)
      setPreview(null)
      setError(null)
      setNotice(null)
      autoLockInFlight.current = false
    }).then((dispose) => {
      unlisten = dispose
    })

    return () => {
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!notice) {
      return undefined
    }

    const timeout = window.setTimeout(
      () => setNotice(null),
      notice.tone === "warning" ? 6000 : 3000,
    )
    return () => window.clearTimeout(timeout)
  }, [notice])

  const activeProject = useMemo(() => {
    if (!snapshot || snapshot.locked) {
      return null
    }

    return (
      snapshot.projects.find((project) => project.id === snapshot.active_project_id) ??
      snapshot.projects[0] ??
      null
    )
  }, [snapshot])

  const missingEntries = useMemo(
    () => (activeProject ? getMissingEntries(activeProject) : []),
    [activeProject],
  )

  const filteredEntries = useMemo(() => {
    if (!activeProject) {
      return []
    }

    const normalizedQuery = searchQuery.trim().toLowerCase()
    if (!normalizedQuery) {
      return activeProject.entries
    }

    return activeProject.entries.filter((entry) => {
      return (
        entry.name.toLowerCase().includes(normalizedQuery) ||
        (entry.category ?? "").toLowerCase().includes(normalizedQuery) ||
        (entry.description ?? "").toLowerCase().includes(normalizedQuery)
      )
    })
  }, [activeProject, searchQuery])

  useEffect(() => {
    if (activeProject && !isRenamingProject) {
      setProjectNameDraft(activeProject.name)
    }
  }, [activeProject, isRenamingProject])

  useEffect(() => {
    if (!snapshot || snapshot.locked) {
      autoLockInFlight.current = false
      lastSessionTouchAt.current = 0
      sessionTouchInFlight.current = false
      return undefined
    }

    let idleTimeout = window.setTimeout(() => {
      void requestLock({
        tone: "warning",
        message: "Locked after 5 minutes of inactivity.",
      })
    }, IDLE_LOCK_MS)

    function resetIdleTimer() {
      window.clearTimeout(idleTimeout)
      idleTimeout = window.setTimeout(() => {
        void requestLock({
          tone: "warning",
          message: "Locked after 5 minutes of inactivity.",
        })
      }, IDLE_LOCK_MS)
    }

    function handleUserActivity() {
      resetIdleTimer()
      void touchBackendSession()
    }

    window.addEventListener("pointerdown", handleUserActivity)
    window.addEventListener("keydown", handleUserActivity)

    return () => {
      window.clearTimeout(idleTimeout)
      window.removeEventListener("pointerdown", handleUserActivity)
      window.removeEventListener("keydown", handleUserActivity)
    }
  }, [snapshot])

  async function loadInitialSnapshot() {
    setLoading(true)
    try {
      const next = await getSnapshot()
      setSnapshot(next)
      setError(null)
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }

  async function applySnapshotAction(
    action: Promise<AppSnapshot>,
    successNotice?: BannerNotice,
  ) {
    setBusy(true)
    setError(null)

    try {
      const next = await action
      setSnapshot(next)
      setPreview(null)
      if (successNotice) {
        setNotice(successNotice)
      }
      return true
    } catch (caught) {
      handleActionError(caught)
      return false
    } finally {
      setBusy(false)
    }
  }

  function handleActionError(caught: unknown) {
    const message = getErrorMessage(caught)
    if (message.includes("the app is locked")) {
      resetTransientUi()
      setSnapshot({
        locked: true,
        active_project_id: null,
        projects: [],
      })
    }
    setNotice(null)
    setError(message)
  }

  function resetTransientUi() {
    setPreview(null)
    setSearchQuery("")
    setIsRenamingProject(false)
    setShowAddEntry(false)
    setShowImportEntries(false)
    setShowAddProject(false)
    setShowEditProject(false)
    setEntryDeleteTarget(null)
    setProjectDeleteTarget(null)
  }

  async function touchBackendSession() {
    const now = Date.now()
    if (
      !snapshot ||
      snapshot.locked ||
      document.visibilityState === "hidden" ||
      sessionTouchInFlight.current ||
      now - lastSessionTouchAt.current < SESSION_TOUCH_THROTTLE_MS
    ) {
      return
    }

    sessionTouchInFlight.current = true
    try {
      await touchSession()
      lastSessionTouchAt.current = Date.now()
    } catch (caught) {
      const message = getErrorMessage(caught)
      if (message.includes("the app is locked")) {
        handleActionError(caught)
      }
    } finally {
      sessionTouchInFlight.current = false
    }
  }

  async function requestLock(nextNotice: BannerNotice) {
    if (!snapshot || snapshot.locked || autoLockInFlight.current) {
      return
    }

    autoLockInFlight.current = true
    resetTransientUi()
    try {
      await applySnapshotAction(lockApp(), nextNotice)
    } finally {
      autoLockInFlight.current = false
    }
  }

  async function handleUnlock() {
    await applySnapshotAction(unlockApp(), { tone: "success", message: "Unlocked." })
  }

  async function handleLock() {
    await requestLock({ tone: "success", message: "Locked." })
  }

  async function handleCreateProject(input: CreateProjectInput) {
    const success = await applySnapshotAction(createProject(input), {
      tone: "success",
      message: "Project created.",
    })
    if (success) {
      setShowAddProject(false)
      setSearchQuery("")
    }
  }

  async function handleCreateEntry(input: CreateEntryInput) {
    const success = await applySnapshotAction(createEntry(input), {
      tone: "success",
      message: "Entry created.",
    })
    if (success) {
      setShowAddEntry(false)
    }
  }

  async function handleImportEntries(projectId: string, environment: string, entries: ImportEntryItem[]) {
    setBusy(true)
    setError(null)
    try {
      const result = await importEntries({
        project_id: projectId,
        environment,
        entries,
      })
      setSnapshot(result.snapshot)
      setPreview(null)
      const parts: string[] = []
      if (result.created > 0) parts.push(`${result.created} created`)
      if (result.updated > 0) parts.push(`${result.updated} updated`)
      setNotice({
        tone: "success",
        message: `Import complete — ${parts.join(", ")}.`,
      })
      setShowImportEntries(false)
    } catch (caught) {
      handleActionError(caught)
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdateProject(input: UpdateProjectInput) {
    const success = await applySnapshotAction(updateProject(input), {
      tone: "success",
      message: "Project updated.",
    })
    if (success) {
      setShowEditProject(false)
      setIsRenamingProject(false)
    }
  }

  async function handleRenameActiveProject() {
    if (!activeProject) {
      return
    }

    const name = projectNameDraft.trim()
    if (!name) {
      setError("Project name cannot be empty.")
      return
    }

    const success = await applySnapshotAction(
      renameProject(activeProject.id, name),
      { tone: "success", message: "Project renamed." },
    )
    if (success) {
      setIsRenamingProject(false)
    }
  }

  async function handleDeleteEntry() {
    if (!entryDeleteTarget) {
      return
    }

    const success = await applySnapshotAction(
      deleteEntry(entryDeleteTarget.projectId, entryDeleteTarget.entryId),
      {
        tone: "success",
        message: `${entryDeleteTarget.entryName} deleted.`,
      },
    )
    if (success) {
      setEntryDeleteTarget(null)
    }
  }

  async function handleDeleteProject() {
    if (!projectDeleteTarget) {
      return
    }

    const success = await applySnapshotAction(deleteProject(projectDeleteTarget.projectId), {
      tone: "success",
      message: `${projectDeleteTarget.projectName} deleted.`,
    })
    if (success) {
      setProjectDeleteTarget(null)
      setShowEditProject(false)
      setIsRenamingProject(false)
      setSearchQuery("")
    }
  }

  async function handlePreview() {
    if (!activeProject) {
      return
    }

    setBusy(true)
    setError(null)
    try {
      const nextPreview = await previewProject(activeProject.id)
      setPreview(nextPreview)
    } catch (caught) {
      handleActionError(caught)
    } finally {
      setBusy(false)
    }
  }

  async function copySensitiveText(value: string, message: string) {
    await copyText(value)
    scheduleClipboardClearIfUnchanged(value)
    setNotice({
      tone: "warning",
      message: `${message} Clipboard remains readable by other apps until it is overwritten. sigyn will try to clear it in 60 seconds if unchanged.`,
    })
  }

  async function handleCopyEffectiveEnv(serialized?: string) {
    if (!serialized && !activeProject) {
      return
    }

    setBusy(true)
    setError(null)
    try {
      const value =
        serialized ?? (activeProject ? (await previewProject(activeProject.id)).serialized : null)
      if (!value) {
        return
      }
      await copySensitiveText(value, "Copied effective env.")
    } catch (caught) {
      handleActionError(caught)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <main className="screen screen--center">
        <div className="card card--narrow">
          <p className="muted">Loading local state...</p>
        </div>
      </main>
    )
  }

  if (!snapshot || snapshot.locked) {
    return (
      <main className="lock-split">
        <div className="lock-split__brand">
          <div className="lock-split__brand-inner">
            <div className="lock-split__brand-icon">
              <img src={appIcon} alt="Sigyn" width={48} height={48} />
            </div>
            <h1 className="lock-split__brand-name">Sigyn</h1>
            <p className="lock-split__brand-tagline">Secure environment manager</p>
          </div>
        </div>
        <div className="lock-split__panel">
          <section className="lock-split__form">
            <button className="button button--primary button--full button--lg" disabled={busy} onClick={handleUnlock}>
              <Lock size={16} />
              {busy ? "Unlocking..." : "Unlock"}
            </button>
            {error ? <Banner tone="danger" message={error} /> : null}
          </section>
        </div>
      </main>
    )
  }

  return (
    <>
      <div className="app-shell">
        <ProjectSidebar
          projects={snapshot.projects}
          activeProjectId={activeProject?.id ?? null}
          onSelectProject={(projectId) => void applySnapshotAction(selectProject(projectId))}
          onAddProject={() => setShowAddProject(true)}
        />

        <main className="workspace">
          <header className="workspace__header">
            {activeProject ? (
              <>
                <div className="workspace__topbar">
                  <div className="workspace__titleblock">
                    {isRenamingProject ? (
                      <div className="inline-edit">
                        <input
                          className="input input--title"
                          value={projectNameDraft}
                          disabled={busy}
                          onChange={(event) => setProjectNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void handleRenameActiveProject()
                            }
                            if (event.key === "Escape") {
                              setIsRenamingProject(false)
                              setProjectNameDraft(activeProject.name)
                            }
                          }}
                          autoFocus
                        />
                        <button
                          className="icon-button"
                          disabled={busy}
                          onClick={() => void handleRenameActiveProject()}
                          aria-label="Save project name"
                        >
                          <Check size={16} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={busy}
                          onClick={() => {
                            setIsRenamingProject(false)
                            setProjectNameDraft(activeProject.name)
                          }}
                          aria-label="Cancel rename"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ) : (
                      <div className="heading-row">
                        <h1>{activeProject.name}</h1>
                      </div>
                    )}
                    <p className="muted">
                      {activeProject.entries.length} entries · {activeProject.supported_environments.length}{" "}
                      environments
                    </p>
                    {activeProject.working_directory && (
                      <div className="metadata-list">
                        <span className="metadata-chip">
                          Working dir: {activeProject.working_directory}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="header-actions">
                    <button
                      className="button button--ghost"
                      disabled={busy}
                      onClick={() => {
                        setIsRenamingProject(false)
                        setProjectNameDraft(activeProject.name)
                        setShowEditProject(true)
                      }}
                    >
                      <Pencil size={16} />
                      Edit Project
                    </button>
                    <button
                      className="button button--ghost"
                      disabled={busy}
                      onClick={() => void handlePreview()}
                    >
                      Preview
                    </button>
                    <button
                      className="button button--primary"
                      disabled={busy}
                      onClick={() => void handleCopyEffectiveEnv()}
                    >
                      <Copy size={16} />
                      Copy
                    </button>
                    <button className="button button--danger" disabled={busy} onClick={handleLock}>
                      <Shield size={16} />
                      Lock Now
                    </button>
                  </div>
                </div>

                <EnvironmentBar
                  project={activeProject}
                  disabled={busy}
                  onSelect={(environment) =>
                    void applySnapshotAction(
                      setBaseEnvironment(activeProject.id, environment),
                    )
                  }
                  onReset={() =>
                    void applySnapshotAction(
                      resetOverrides(activeProject.id),
                      {
                        tone: "success",
                        message: "Overrides cleared.",
                      },
                    )
                  }
                />

                <section className="cli-card">
                  <button
                    type="button"
                    className="cli-card__toggle"
                    onClick={() => setIsCliPanelExpanded((current) => !current)}
                    aria-expanded={isCliPanelExpanded}
                    aria-controls="companion-cli-panel"
                  >
                    <div className="cli-card__title">
                      <Terminal size={16} />
                      Companion CLI
                    </div>
                    <div className="cli-card__toggle-meta">
                      <span className="muted muted--small">
                        {isCliPanelExpanded ? "Hide usage" : "Show usage"}
                      </span>
                      {isCliPanelExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </div>
                  </button>

                  {isCliPanelExpanded ? (
                    <div id="companion-cli-panel" className="cli-card__content">
                      <p className="muted muted--small">
                        The install script puts <code>sigyn</code> on your PATH. It authenticates
                        locally, reads the encrypted store directly, and injects the resolved env
                        into the child command.
                      </p>

                      <p className="muted muted--small cli-usage-label">Usage</p>
                      <code className="code-block">
                        {`# uses the active project (${activeProject.name})\nsigyn uv run python -m your_module\n\n# target a specific project\nsigyn run --project ${shellQuote(activeProject.name)} -- uv run python -m your_module`}
                      </code>
                    </div>
                  ) : null}
                </section>

                <div className="toolbar">
                  <label className="search">
                    <Search size={16} />
                    <input
                      value={searchQuery}
                      placeholder="Search entries..."
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                  </label>
                  <div className="toolbar__actions">
                    <button
                      className="button button--ghost"
                      disabled={busy}
                      onClick={() => setShowImportEntries(true)}
                    >
                      <Upload size={16} />
                      Import
                    </button>
                    <button
                      className="button button--primary"
                      disabled={busy}
                      onClick={() => setShowAddEntry(true)}
                    >
                      <Plus size={16} />
                      Add Entry
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state empty-state--header">
                <h1>No projects yet</h1>
                <p className="muted">
                  Create a project to define its environments, then add entries with per-environment
                  values.
                </p>
                <button className="button button--primary" onClick={() => setShowAddProject(true)}>
                  <Plus size={16} />
                  Create Project
                </button>
              </div>
            )}

            {error ? <Banner tone="danger" message={error} /> : null}
            {notice ? <Banner tone={notice.tone} message={notice.message} /> : null}

            {activeProject && missingEntries.length > 0 ? (
              <Banner
                tone="warning"
                message={`${missingEntries.length} entr${
                  missingEntries.length === 1 ? "y is" : "ies are"
                } missing a value for the current effective selection and will be skipped.`}
              />
            ) : null}
          </header>

          <section className="workspace__content">
            {activeProject ? (
              <>
                {filteredEntries.length > 0 ? (
                  <div className="entry-list">
                    {filteredEntries.map((entry) => (
                      <EntryCard
                        key={entry.id}
                        project={activeProject}
                        entry={entry}
                        selectedEnvironment={getSelectedEnvironment(activeProject, entry.id)}
                        onSelectEnvironment={(entryId, environment) =>
                          applySnapshotAction(
                            setEntryOverride(activeProject.id, entryId, environment),
                            {
                              tone: "success",
                              message: environment
                                ? `Using ${environment} for ${entry.name}.`
                                : `Reset ${entry.name} to the base preset.`,
                            },
                          )
                        }
                        onSave={(input) =>
                          applySnapshotAction(updateEntry(input), {
                            tone: "success",
                            message: `${entry.name} updated.`,
                          })
                        }
                        onDelete={() =>
                          setEntryDeleteTarget({
                            projectId: activeProject.id,
                            entryId: entry.id,
                            entryName: entry.name,
                          })
                        }
                        onCopySecret={(value) => copySensitiveText(value, "Copied secret value.")}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <h2>No matching entries</h2>
                    <p className="muted">
                      {searchQuery
                        ? "Try a different query or clear search."
                        : "Add the first entry for this project to start composing runtime envs."}
                    </p>
                  </div>
                )}
              </>
            ) : null}
          </section>
        </main>
      </div>

      <ProjectDialog
        open={showAddProject}
        busy={busy}
        title="Create Project"
        subtitle="Define the project identity and the supported environment labels that drive the active preset."
        submitLabel="Create Project"
        initialName=""
        initialEnvironmentText={DEFAULT_ENVS.join(", ")}
        initialWorkingDirectory=""
        onClose={() => setShowAddProject(false)}
        onSubmit={(values) =>
          handleCreateProject({
            name: values.name,
            supported_environments: parseEnvironmentList(values.environmentText),
            working_directory: values.workingDirectory || null,
          })
        }
      />

      <ProjectDialog
        open={showEditProject && Boolean(activeProject)}
        busy={busy}
        title="Edit Project"
        subtitle="Add supported environments or update the project metadata without recreating the project."
        submitLabel="Save Project"
        environmentHelpText="Removing existing environments is not supported yet."
        initialName={activeProject?.name ?? ""}
        initialEnvironmentText={activeProject?.supported_environments.join(", ") ?? DEFAULT_ENVS.join(", ")}
        initialWorkingDirectory={activeProject?.working_directory ?? ""}
        onClose={() => setShowEditProject(false)}
        onDelete={
          activeProject
            ? () => {
                setShowEditProject(false)
                setProjectDeleteTarget({
                  projectId: activeProject.id,
                  projectName: activeProject.name,
                })
              }
            : undefined
        }
        onSubmit={(values) =>
          activeProject
            ? handleUpdateProject({
                project_id: activeProject.id,
                name: values.name,
                supported_environments: parseEnvironmentList(values.environmentText),
                working_directory: values.workingDirectory || null,
              })
            : Promise.resolve()
        }
      />

      <ProjectDeleteDialog
        open={Boolean(projectDeleteTarget)}
        busy={busy}
        projectName={projectDeleteTarget?.projectName ?? ""}
        onClose={() => setProjectDeleteTarget(null)}
        onConfirm={() => void handleDeleteProject()}
      />

      <EntryDialog
        open={showAddEntry && Boolean(activeProject)}
        busy={busy}
        project={activeProject}
        onClose={() => setShowAddEntry(false)}
        onSubmit={handleCreateEntry}
      />

      <ImportDialog
        open={showImportEntries && Boolean(activeProject)}
        busy={busy}
        project={activeProject}
        onClose={() => setShowImportEntries(false)}
        onImport={handleImportEntries}
      />

      <PreviewDialog
        preview={preview}
        onClose={() => setPreview(null)}
        onCopy={() => void handleCopyEffectiveEnv(preview?.serialized)}
      />

      <ConfirmDialog
        open={Boolean(entryDeleteTarget)}
        busy={busy}
        title="Delete entry"
        subtitle={
          entryDeleteTarget
            ? `Delete ${entryDeleteTarget.entryName}? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete Entry"
        onClose={() => setEntryDeleteTarget(null)}
        onConfirm={() => void handleDeleteEntry()}
      />
    </>
  )
}

function ProjectSidebar({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
}: {
  projects: ProjectRecord[]
  activeProjectId: string | null
  onSelectProject: (projectId: string) => void
  onAddProject: () => void
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img src={appIcon} alt="Sigyn" width={28} height={28} className="sidebar__icon" />
        <div className="sidebar__title">Sigyn</div>
      </div>

      <div className="sidebar__section-label">Projects</div>

      <nav className="sidebar__nav">
        {projects.length > 0 ? (
          projects.map((project) => (
            <button
              key={project.id}
              className={`project-link ${project.id === activeProjectId ? "project-link--active" : ""}`}
              onClick={() => onSelectProject(project.id)}
            >
              <span className="project-link__name">{project.name}</span>
              <span className="project-link__count">{project.entries.length}</span>
            </button>
          ))
        ) : (
          <div className="sidebar__empty">No projects saved yet.</div>
        )}
      </nav>

      <div className="sidebar__footer">
        <button className="button button--ghost button--full" onClick={onAddProject}>
          <Plus size={16} />
          Add Project
        </button>
      </div>
    </aside>
  )
}

function EnvironmentBar({
  project,
  disabled,
  onSelect,
  onReset,
}: {
  project: ProjectRecord
  disabled: boolean
  onSelect: (environment: string) => void
  onReset: () => void
}) {
  const overrideCount = Object.keys(project.entry_overrides).length
  const isMixed = overrideCount > 0

  const distribution = useMemo(() => {
    if (!isMixed || project.entries.length === 0) {
      return []
    }
    const counts: Record<string, number> = {}
    for (const entry of project.entries) {
      const env = getSelectedEnvironment(project, entry.id)
      counts[env] = (counts[env] ?? 0) + 1
    }
    return Object.entries(counts).sort(([, a], [, b]) => b - a)
  }, [project, isMixed])

  return (
    <div className={`env-bar ${isMixed ? "env-bar--mixed" : ""}`}>
      <div className="env-bar__row">
        <div className="env-bar__pills">
          {project.supported_environments.map((env) => (
            <button
              key={env}
              className={`env-pill ${env === project.active_base_environment ? "env-pill--active" : ""}`}
              disabled={disabled}
              onClick={() => onSelect(env)}
            >
              {formatEnvironmentLabel(env)}
            </button>
          ))}
        </div>

        {isMixed && (
          <button className="button button--ghost env-bar__reset" disabled={disabled} onClick={onReset}>
            <RotateCcw size={14} />
            Reset to {formatEnvironmentLabel(project.active_base_environment)}
          </button>
        )}
      </div>

      {isMixed && distribution.length > 0 && (
        <div className="env-bar__mixed-summary">
          <AlertTriangle size={14} />
          <span>
            Mixed — {overrideCount} entr{overrideCount === 1 ? "y" : "ies"} overridden
          </span>
          <div className="env-bar__dist">
            {distribution.map(([env, count]) => (
              <span
                key={env}
                className={`env-dist-chip ${
                  env !== project.active_base_environment ? "env-dist-chip--override" : ""
                }`}
              >
                {count} {formatEnvironmentLabel(env)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function EntryCard({
  project,
  entry,
  selectedEnvironment,
  onSelectEnvironment,
  onSave,
  onDelete,
  onCopySecret,
}: {
  project: ProjectRecord
  entry: EntryRecord
  selectedEnvironment: string
  onSelectEnvironment: (entryId: string, environment: string | null) => Promise<unknown>
  onSave: (input: UpdateEntryInput) => Promise<unknown>
  onDelete: () => void
  onCopySecret: (value: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [valuesLoaded, setValuesLoaded] = useState(false)
  const [draftName, setDraftName] = useState(entry.name)
  const [draftCategory, setDraftCategory] = useState(entry.category ?? "")
  const [draftDescription, setDraftDescription] = useState(entry.description ?? "")
  const [draftValues, setDraftValues] = useState<Record<string, ValueDraft>>(() =>
    buildEntryDraftValues(project, entry),
  )
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [valueFocused, setValueFocused] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setDraftName(entry.name)
    setDraftCategory(entry.category ?? "")
    setDraftDescription(entry.description ?? "")
    setDraftValues(buildEntryDraftValues(project, entry))
    setRevealed({})
    setValuesLoaded(false)
  }, [entry, project])

  useEffect(() => {
    if (expanded && !valuesLoaded) {
      void loadValues()
    }
  }, [expanded, valuesLoaded])

  const hasActiveValue = entry.values.some((v) => v.environment === selectedEnvironment)

  async function loadValues() {
    try {
      const result = await getEntryValues(project.id, entry.id)
      setDraftValues((current) => {
        const next = { ...current }
        for (const item of result.values) {
          next[item.environment] = { present: true, value: item.value }
        }
        return next
      })
      setValuesLoaded(true)
    } catch {
      // will retry on next effect cycle
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onSave({
        project_id: project.id,
        entry_id: entry.id,
        name: draftName,
        category: draftCategory || null,
        description: draftDescription || null,
        values: project.supported_environments.map((environment) => ({
          environment,
          present: draftValues[environment]?.present ?? false,
          value: draftValues[environment]?.value ?? "",
        })),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className="entry-card">
      <div className="entry-card__summary">
        <button
          className="icon-button"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? "Collapse entry" : "Expand entry"}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="entry-card__identity">
          <div className="entry-card__name-row">
            <span className="mono">{entry.name}</span>
            <span className={`status-dot ${hasActiveValue ? "status-dot--ok" : "status-dot--missing"}`} />
          </div>
          {entry.category || entry.description ? (
            <p className="muted muted--small">
              {[entry.category, entry.description].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>

        <div className="entry-card__spacer" />

        <label className="entry-card__select">
          <span className="muted muted--small">Active</span>
          <select
            value={selectedEnvironment}
            onChange={(event) =>
              void onSelectEnvironment(
                entry.id,
                event.target.value === project.active_base_environment ? null : event.target.value,
              )
            }
          >
            {project.supported_environments.map((environment) => (
              <option key={environment} value={environment}>
                {formatEnvironmentLabel(environment)}
              </option>
            ))}
          </select>
        </label>

        <div className="entry-card__masked">
          {hasActiveValue ? "••••••••" : <span className="danger">not set</span>}
        </div>
      </div>

      {expanded ? (
        <div className="entry-card__details">
          <div className="entry-card__fields">
            <label>
              <span>Name</span>
              <input
                className="input"
                value={draftName}
                disabled={saving}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </label>
            <label>
              <span>Category</span>
              <input
                className="input"
                value={draftCategory}
                disabled={saving}
                placeholder="optional"
                onChange={(event) => setDraftCategory(event.target.value)}
              />
            </label>
          </div>

          <label className="entry-card__textarea-label">
            <span>Description</span>
            <textarea
              className="textarea"
              value={draftDescription}
              disabled={saving}
              placeholder="optional"
              onChange={(event) => setDraftDescription(event.target.value)}
            />
          </label>

          <div className="env-value-section-label">ENVIRONMENT VALUES</div>
          <div className="env-value-list">
            {project.supported_environments.map((environment) => {
              const draft = draftValues[environment] ?? { present: false, value: "" }
              const isActive = selectedEnvironment === environment
              const canUseBase = environment === project.active_base_environment
              const isMasked = draft.present && !revealed[environment]

              return (
                <div
                  key={environment}
                  className={`env-value-row ${isActive ? "env-value-row--active" : ""}`}
                >
                  <button
                    className="env-value-row__label"
                    disabled={saving}
                    onClick={() =>
                      void onSelectEnvironment(entry.id, canUseBase ? null : environment)
                    }
                  >
                    <span
                      className={`status-dot ${draft.present ? "status-dot--ok" : "status-dot--missing"}`}
                    />
                    {isActive ? (
                      <span className="env-value-row__chip">
                        {formatEnvironmentLabel(environment)}
                      </span>
                    ) : (
                      <span className="env-value-row__name">
                        {formatEnvironmentLabel(environment)}
                      </span>
                    )}
                  </button>

                  <input
                    className={`env-value-row__input ${
                      isMasked ? "env-value-row__input--masked" : ""
                    }`}
                    type="text"
                    autoComplete="off"
                    disabled={saving || !valuesLoaded}
                    readOnly={isMasked}
                    value={
                      isMasked
                        ? OBSCURED_SECRET_MASK
                        : valueFocused[environment]
                          ? draft.value
                          : displayWhitespace(draft.value)
                    }
                    placeholder={draft.present ? "" : "not set"}
                    onFocus={() => {
                      setValueFocused((current) => ({ ...current, [environment]: true }))
                      if (!isMasked) {
                        return
                      }

                      setRevealed((current) => ({
                        ...current,
                        [environment]: true,
                      }))
                    }}
                    onBlur={() => {
                      setValueFocused((current) => ({ ...current, [environment]: false }))
                    }}
                    onChange={(event) =>
                      {
                        setDraftValues((current) => ({
                          ...current,
                          [environment]: {
                            present: true,
                            value: event.target.value,
                          },
                        }))
                        setRevealed((current) => ({
                          ...current,
                          [environment]: true,
                        }))
                      }
                    }
                  />

                  <div className="env-value-row__actions">
                    <button
                      className="icon-button icon-button--sm"
                      disabled={!draft.present || saving || !valuesLoaded}
                      onClick={() =>
                        setRevealed((current) => ({
                          ...current,
                          [environment]: !current[environment],
                        }))
                      }
                      aria-label={revealed[environment] ? "Hide" : "Reveal"}
                    >
                      {revealed[environment] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      className="icon-button icon-button--sm"
                      disabled={!draft.present || saving || !valuesLoaded}
                      onClick={() => void onCopySecret(draft.value)}
                      aria-label="Copy value"
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      className="icon-button icon-button--sm"
                      disabled={saving || !valuesLoaded}
                      onClick={() =>
                        setDraftValues((current) => ({
                          ...current,
                          [environment]: { present: false, value: "" },
                        }))
                      }
                      aria-label="Remove value"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="entry-card__footer">
            <button className="button button--danger" disabled={saving} onClick={onDelete}>
              <Trash2 size={16} />
              Delete Entry
            </button>
            <button className="button button--primary" disabled={saving || !valuesLoaded} onClick={() => void handleSave()}>
              {saving ? "Saving..." : !valuesLoaded ? "Loading…" : "Save Changes"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  )
}

function ProjectDialog({
  open,
  busy,
  title,
  subtitle,
  submitLabel,
  environmentHelpText,
  initialName,
  initialEnvironmentText,
  initialWorkingDirectory,
  onClose,
  onDelete,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  title: string
  subtitle: string
  submitLabel: string
  environmentHelpText?: string
  initialName: string
  initialEnvironmentText: string
  initialWorkingDirectory: string
  onClose: () => void
  onDelete?: () => void
  onSubmit: (values: ProjectFormValues) => Promise<void>
}) {
  const [name, setName] = useState(initialName)
  const [environmentText, setEnvironmentText] = useState(initialEnvironmentText)
  const [workingDirectory, setWorkingDirectory] = useState(initialWorkingDirectory)

  useEffect(() => {
    if (open) {
      setName(initialName)
      setEnvironmentText(initialEnvironmentText)
      setWorkingDirectory(initialWorkingDirectory)
    }
  }, [open, initialEnvironmentText, initialName, initialWorkingDirectory])

  if (!open) {
    return null
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <label>
        <span>Project name</span>
        <input
          className="input"
          value={name}
          disabled={busy}
          placeholder="retail-service"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <label>
        <span>Supported environments</span>
        <input
          className="input"
          value={environmentText}
          disabled={busy}
          placeholder="local, dev, staging, prod"
          onChange={(event) => setEnvironmentText(event.target.value)}
        />
      </label>
      {environmentHelpText ? <p className="muted muted--small">{environmentHelpText}</p> : null}

      <label>
        <span>Default working directory</span>
        <input
          className="input"
          value={workingDirectory}
          disabled={busy}
          placeholder="/Users/me/code/retail-service"
          onChange={(event) => setWorkingDirectory(event.target.value)}
        />
        <p className="muted muted--small">
          Used as the current directory when running commands via{" "}
          <code>sigyn run</code>. Falls back to the caller's working directory if not set.
        </p>
      </label>

      <div className="modal__footer">
        {onDelete ? (
          <button className="button button--danger modal__footer-action--danger" disabled={busy} onClick={onDelete}>
            <Trash2 size={16} />
            Delete Project
          </button>
        ) : null}
        <button className="button button--ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button button--primary"
          disabled={busy}
          onClick={() =>
            void onSubmit({
              name,
              environmentText,
              workingDirectory,
            })
          }
        >
          {submitLabel}
        </button>
      </div>
    </Modal>
  )
}

function ProjectDeleteDialog({
  open,
  busy,
  projectName,
  onClose,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  projectName: string
  onClose: () => void
  onConfirm: () => void
}) {
  const [confirmationName, setConfirmationName] = useState("")

  useEffect(() => {
    if (open) {
      setConfirmationName("")
    }
  }, [open, projectName])

  if (!open) {
    return null
  }

  const matchesProjectName = confirmationName === projectName

  function handleClose() {
    if (!busy) {
      onClose()
    }
  }

  return (
    <Modal
      title="Delete project"
      subtitle="This permanently removes the project, its entries, and all saved values."
      onClose={handleClose}
    >
      <p className="muted muted--small">
        Type <span className="mono">{projectName}</span> to confirm this action.
      </p>

      <label>
        <span>Project name</span>
        <input
          className="input"
          value={confirmationName}
          disabled={busy}
          placeholder={projectName}
          onChange={(event) => setConfirmationName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matchesProjectName && !busy) {
              onConfirm()
            }
          }}
        />
      </label>

      <div className="modal__footer">
        <button className="button button--ghost" disabled={busy} onClick={handleClose}>
          Cancel
        </button>
        <button
          className="button button--danger"
          disabled={busy || !matchesProjectName}
          onClick={onConfirm}
        >
          <Trash2 size={16} />
          Delete Project
        </button>
      </div>
    </Modal>
  )
}

function EntryDialog({
  open,
  busy,
  project,
  onClose,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  project: ProjectRecord | null
  onClose: () => void
  onSubmit: (input: CreateEntryInput) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [category, setCategory] = useState("")
  const [description, setDescription] = useState("")
  const [values, setValues] = useState<Record<string, ValueDraft>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [valueFocused, setValueFocused] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (open && project) {
      setName("")
      setCategory("")
      setDescription("")
      setValues(
        Object.fromEntries(
          project.supported_environments.map((environment) => [
            environment,
            { present: false, value: "" },
          ]),
        ),
      )
      setRevealed({})
      setValueFocused({})
    }
  }, [open, project])

  if (!open || !project) {
    return null
  }

  return (
    <Modal
      title="Add Entry"
      subtitle="Create a named env entry and optionally define values for each supported environment."
      onClose={onClose}
    >
      <label>
        <span>Entry name</span>
        <input
          className="input"
          value={name}
          disabled={busy}
          placeholder="DATABASE_URL"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className="modal__grid">
        <label>
          <span>Category</span>
          <input
            className="input"
            value={category}
            disabled={busy}
            placeholder="optional"
            onChange={(event) => setCategory(event.target.value)}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            className="input"
            value={description}
            disabled={busy}
            placeholder="optional"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>

      <div className="env-value-section-label">ENVIRONMENT VALUES</div>
      <div className="env-value-list">
        {project.supported_environments.map((environment) => {
          const draft = values[environment] ?? { present: false, value: "" }
          const isMasked = draft.present && !revealed[environment]
          return (
            <div key={environment} className="env-value-row">
              <div className="env-value-row__label env-value-row__label--static">
                <span
                  className={`status-dot ${draft.present ? "status-dot--ok" : "status-dot--missing"}`}
                />
                <span className="env-value-row__name">
                  {formatEnvironmentLabel(environment)}
                </span>
              </div>

              <input
                className={`env-value-row__input ${
                  isMasked ? "env-value-row__input--masked" : ""
                }`}
                type="text"
                autoComplete="off"
                disabled={busy}
                readOnly={isMasked}
                value={
                  isMasked
                    ? OBSCURED_SECRET_MASK
                    : valueFocused[environment]
                      ? draft.value
                      : displayWhitespace(draft.value)
                }
                placeholder="not set"
                onFocus={() => {
                  setValueFocused((current) => ({ ...current, [environment]: true }))
                  if (!isMasked) {
                    return
                  }

                  setRevealed((current) => ({
                    ...current,
                    [environment]: true,
                  }))
                }}
                onBlur={() => {
                  setValueFocused((current) => ({ ...current, [environment]: false }))
                }}
                onChange={(event) =>
                  {
                    setValues((current) => ({
                      ...current,
                      [environment]: {
                        present: true,
                        value: event.target.value,
                      },
                    }))
                    setRevealed((current) => ({
                      ...current,
                      [environment]: true,
                    }))
                  }
                }
              />

              <div className="env-value-row__actions">
                <button
                  className="icon-button icon-button--sm"
                  disabled={!draft.present || busy}
                  onClick={() =>
                    setRevealed((current) => ({
                      ...current,
                      [environment]: !current[environment],
                    }))
                  }
                  aria-label={revealed[environment] ? "Hide" : "Reveal"}
                >
                  {revealed[environment] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  className="icon-button icon-button--sm"
                  disabled={busy}
                  onClick={() =>
                    setValues((current) => ({
                      ...current,
                      [environment]: { present: false, value: "" },
                    }))
                  }
                  aria-label="Remove value"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="modal__footer">
        <button className="button button--ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button button--primary"
          disabled={busy}
          onClick={() =>
            void onSubmit({
              project_id: project.id,
              name,
              category: category || null,
              description: description || null,
              values: project.supported_environments.map((environment) => ({
                environment,
                present: values[environment]?.present ?? false,
                value: values[environment]?.value ?? "",
              })),
            })
          }
        >
          Create Entry
        </button>
      </div>
    </Modal>
  )
}

function ImportDialog({
  open,
  busy,
  project,
  onClose,
  onImport,
}: {
  open: boolean
  busy: boolean
  project: ProjectRecord | null
  onClose: () => void
  onImport: (projectId: string, environment: string, entries: ImportEntryItem[]) => Promise<void>
}) {
  const [envText, setEnvText] = useState("")
  const [environment, setEnvironment] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && project) {
      setEnvText("")
      setEnvironment(project.active_base_environment)
    }
  }, [open, project])

  const parsed = useMemo(() => parseEnvText(envText), [envText])

  const existingNames = useMemo(() => {
    if (!project) return new Set<string>()
    return new Set(project.entries.map((e) => e.name))
  }, [project])

  if (!open || !project) {
    return null
  }

  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result
      if (typeof text === "string") {
        setEnvText(text)
      }
    }
    reader.readAsText(file)
    event.target.value = ""
  }

  return (
    <Modal
      title="Import Entries"
      subtitle="Paste .env content or load a file. All parsed entries will be assigned to the selected environment."
      onClose={onClose}
    >
      <label>
        <span>Target environment</span>
        <select
          className="input"
          value={environment}
          disabled={busy}
          onChange={(event) => setEnvironment(event.target.value)}
        >
          {project.supported_environments.map((env) => (
            <option key={env} value={env}>
              {formatEnvironmentLabel(env)}
            </option>
          ))}
        </select>
      </label>

      <div className="import-source">
        <div className="import-source__header">
          <span>.env content</span>
          <button
            className="button button--ghost button--sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
            Load file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".env,.env.*,text/*"
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
        </div>
        <textarea
          className="textarea textarea--import"
          value={envText}
          disabled={busy}
          placeholder={"DATABASE_URL=postgres://localhost/mydb\nAPI_KEY=sk-abc123\nDEBUG=true"}
          onChange={(event) => setEnvText(event.target.value)}
        />
      </div>

      {parsed.length > 0 && (
        <div className="import-preview">
          <div className="import-preview__header">
            {parsed.length} entr{parsed.length === 1 ? "y" : "ies"} found
          </div>
          <div className="import-preview__list">
            {parsed.map((item, index) => {
              const normalized = item.name
                .trim()
                .replace(/^export\s+/i, "")
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "_")
                .replace(/^_+|_+$/g, "")
              const isExisting = existingNames.has(normalized)
              return (
                <div key={index} className="import-preview__row">
                  <span className="mono">{item.name}</span>
                  <span
                    className={`import-preview__badge ${
                      isExisting ? "import-preview__badge--update" : "import-preview__badge--new"
                    }`}
                  >
                    {isExisting ? "update" : "new"}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="modal__footer">
        <button className="button button--ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button button--primary"
          disabled={busy || parsed.length === 0}
          onClick={() => void onImport(project.id, environment, parsed)}
        >
          <Upload size={16} />
          {busy ? "Importing..." : `Import ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"}`}
        </button>
      </div>
    </Modal>
  )
}

function parseEnvText(text: string): ImportEntryItem[] {
  const entries: ImportEntryItem[] = []

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const stripped = line.replace(/^export\s+/i, "")
    const eqIndex = stripped.indexOf("=")
    if (eqIndex < 1) continue

    const name = stripped.slice(0, eqIndex).trim()
    let value = stripped.slice(eqIndex + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    entries.push({ name, value })
  }

  return entries
}

function PreviewDialog({
  preview,
  onClose,
  onCopy,
}: {
  preview: PreviewResult | null
  onClose: () => void
  onCopy: () => void
}) {
  if (!preview) {
    return null
  }

  return (
    <Modal
      title="Effective Env Preview"
      subtitle={`Preset: ${preview.preset_label} · ${preview.items.length} resolved entries.`}
      onClose={onClose}
    >
      <div className="preview-list">
        {preview.items.map((item) => (
          <div key={item.entry_id} className="preview-row">
            <span className="mono">{item.entry_name}</span>
            <span className="metadata-chip">{item.source_environment}</span>
          </div>
        ))}
      </div>

      <label className="entry-card__textarea-label">
        <span>.env serialization</span>
        <textarea className="textarea textarea--preview" value={preview.serialized} readOnly />
      </label>

      <div className="modal__footer">
        <button className="button button--ghost" onClick={onClose}>
          Close
        </button>
        <button className="button button--primary" onClick={onCopy}>
          <Copy size={16} />
          Copy
        </button>
      </div>
    </Modal>
  )
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div>
            <h2>{title}</h2>
            <p className="muted">{subtitle}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  )
}

function ConfirmDialog({
  open,
  busy,
  title,
  subtitle,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  title: string
  subtitle: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  if (!open) {
    return null
  }

  function handleClose() {
    if (!busy) {
      onClose()
    }
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={handleClose}>
      <div className="modal__footer">
        <button className="button button--ghost" disabled={busy} onClick={handleClose}>
          Cancel
        </button>
        <button className="button button--danger" disabled={busy} onClick={onConfirm}>
          <Trash2 size={16} />
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

function Banner({
  tone,
  message,
}: {
  tone: "danger" | "warning" | "success"
  message: string
}) {
  return (
    <div className={`banner banner--${tone}`}>
      {tone === "warning" ? <AlertTriangle size={16} /> : null}
      {tone === "success" ? <Check size={16} /> : null}
      {tone === "danger" ? <X size={16} /> : null}
      <span>{message}</span>
    </div>
  )
}

function buildEntryDraftValues(
  project: ProjectRecord,
  entry: EntryRecord,
): Record<string, ValueDraft> {
  const map = Object.fromEntries(
    project.supported_environments.map((environment) => [
      environment,
      { present: false, value: "" },
    ]),
  ) as Record<string, ValueDraft>

  for (const value of entry.values) {
    map[value.environment] = { present: true, value: "" }
  }

  return map
}

function getSelectedEnvironment(project: ProjectRecord, entryId: string) {
  return project.entry_overrides[entryId] ?? project.active_base_environment
}

function getValueForEnvironment(entry: EntryRecord, environment: string) {
  return entry.values.find((value) => value.environment === environment) ?? null
}

function getMissingEntries(project: ProjectRecord) {
  return project.entries.filter((entry) => {
    const selectedEnvironment = getSelectedEnvironment(project, entry.id)
    return !getValueForEnvironment(entry, selectedEnvironment)
  })
}

function displayWhitespace(value: string): string {
  return value.replace(/ /g, "·").replace(/\t/g, "→")
}

function formatEnvironmentLabel(environment: string) {
  return environment
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function parseEnvironmentList(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textArea = document.createElement("textarea")
  textArea.value = value
  textArea.style.position = "fixed"
  textArea.style.opacity = "0"
  document.body.appendChild(textArea)
  textArea.select()
  document.execCommand("copy")
  document.body.removeChild(textArea)
}

function scheduleClipboardClearIfUnchanged(value: string) {
  if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) {
    return
  }

  window.setTimeout(() => {
    void navigator.clipboard
      .readText()
      .then((currentValue) => {
        if (currentValue !== value) {
          return
        }
        return navigator.clipboard.writeText("")
      })
      .catch(() => {
        // Best-effort clipboard clearing should not interrupt the UI.
      })
  }, CLIPBOARD_CLEAR_DELAY_MS)
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
