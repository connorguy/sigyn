import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { listen } from "@tauri-apps/api/event"
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Search,
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
  detail?: string
}

type ToastNotice = BannerNotice & {
  id: number
}

type EntryFilter = "all" | "overrides" | "missing"

type EntryStatus = {
  environment: string
  overridden: boolean
  missing: boolean
}

type PanelExitTarget =
  | { kind: "entry"; entryId: string | null }
  | { kind: "project"; projectId: string }

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
const EMPTY_VALUE_DRAFT: ValueDraft = { present: false, value: "" }
const ENV_ABBREVIATIONS: Record<string, string> = {
  local: "LOC",
  dev: "DEV",
  development: "DEV",
  test: "TST",
  testing: "TST",
  qa: "QA",
  uat: "UAT",
  ci: "CI",
  preview: "PRV",
  sandbox: "SBX",
  demo: "DMO",
  stage: "STG",
  staging: "STG",
  prod: "PRD",
  production: "PRD",
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNoticeState] = useState<ToastNotice | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [entryFilter, setEntryFilter] = useState<EntryFilter>("all")
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [panelDirty, setPanelDirty] = useState(false)
  const [pendingPanelExit, setPendingPanelExit] = useState<PanelExitTarget | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showEditProject, setShowEditProject] = useState(false)
  const [showAddEntry, setShowAddEntry] = useState(false)
  const [showImportEntries, setShowImportEntries] = useState(false)
  const [showCliDialog, setShowCliDialog] = useState(false)
  const [isRenamingProject, setIsRenamingProject] = useState(false)
  const [projectNameDraft, setProjectNameDraft] = useState("")
  const [entryDeleteTarget, setEntryDeleteTarget] = useState<EntryDeleteTarget | null>(null)
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<ProjectDeleteTarget | null>(null)
  const autoLockInFlight = useRef(false)
  const lastSessionTouchAt = useRef(0)
  const sessionTouchInFlight = useRef(false)
  const noticeSequence = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  function setNotice(next: BannerNotice | null) {
    noticeSequence.current += 1
    setNoticeState(next ? { ...next, id: noticeSequence.current } : null)
  }

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

  const entryStatuses = useMemo(() => {
    const statuses: Record<string, EntryStatus> = {}
    if (activeProject) {
      for (const entry of activeProject.entries) {
        statuses[entry.id] = getEntryStatus(activeProject, entry)
      }
    }
    return statuses
  }, [activeProject])

  const entryCounts = useMemo(() => {
    const statuses = Object.values(entryStatuses)
    return {
      all: statuses.length,
      overrides: statuses.filter((status) => status.overridden).length,
      missing: statuses.filter((status) => status.missing).length,
    }
  }, [entryStatuses])

  const filteredEntries = useMemo(() => {
    if (!activeProject) {
      return []
    }

    const normalizedQuery = searchQuery.trim().toLowerCase()

    return activeProject.entries.filter((entry) => {
      const status = entryStatuses[entry.id]
      if (entryFilter === "overrides" && !status?.overridden) {
        return false
      }
      if (entryFilter === "missing" && !status?.missing) {
        return false
      }
      if (!normalizedQuery) {
        return true
      }
      return (
        entry.name.toLowerCase().includes(normalizedQuery) ||
        (entry.category ?? "").toLowerCase().includes(normalizedQuery) ||
        (entry.description ?? "").toLowerCase().includes(normalizedQuery)
      )
    })
  }, [activeProject, entryFilter, entryStatuses, searchQuery])

  const selectedEntry = useMemo(() => {
    if (!activeProject || !selectedEntryId) {
      return null
    }
    return activeProject.entries.find((entry) => entry.id === selectedEntryId) ?? null
  }, [activeProject, selectedEntryId])

  const anyDialogOpen =
    showAddProject ||
    showEditProject ||
    showAddEntry ||
    showImportEntries ||
    showCliDialog ||
    Boolean(preview) ||
    Boolean(entryDeleteTarget) ||
    Boolean(projectDeleteTarget)

  useEffect(() => {
    // Saving or discarding resolves a pending "unsaved changes" prompt.
    if (pendingPanelExit && !panelDirty) {
      performPanelExit(pendingPanelExit)
    }
  }, [panelDirty, pendingPanelExit])

  useEffect(() => {
    if (selectedEntryId && !selectedEntry) {
      setSelectedEntryId(null)
      setPanelDirty(false)
      setPendingPanelExit(null)
    }
  }, [selectedEntry, selectedEntryId])

  useEffect(() => {
    if (!activeProject) {
      return undefined
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (anyDialogOpen || event.defaultPrevented) {
        return
      }

      const target = event.target as HTMLElement | null
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable)

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      if (event.key === "Escape") {
        if (editing) {
          target?.blur()
          return
        }
        if (selectedEntryId) {
          event.preventDefault()
          requestPanelExit({ kind: "entry", entryId: null })
        }
        return
      }

      if (editing || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key === "/") {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      const step =
        event.key === "ArrowDown" || event.key === "j"
          ? 1
          : event.key === "ArrowUp" || event.key === "k"
            ? -1
            : 0
      if (step === 0 || filteredEntries.length === 0) {
        return
      }

      event.preventDefault()
      const currentIndex = filteredEntries.findIndex((entry) => entry.id === selectedEntryId)
      const nextIndex =
        currentIndex === -1
          ? step > 0
            ? 0
            : filteredEntries.length - 1
          : Math.min(Math.max(currentIndex + step, 0), filteredEntries.length - 1)
      requestPanelExit({ kind: "entry", entryId: filteredEntries[nextIndex].id })
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  })

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
    setEntryFilter("all")
    setSelectedEntryId(null)
    setPanelDirty(false)
    setPendingPanelExit(null)
    setShowCliDialog(false)
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

  function requestPanelExit(target: PanelExitTarget) {
    if (target.kind === "entry" && target.entryId === selectedEntryId) {
      return
    }
    if (selectedEntryId && panelDirty) {
      setPendingPanelExit(target)
      return
    }
    performPanelExit(target)
  }

  function performPanelExit(target: PanelExitTarget) {
    setPendingPanelExit(null)
    setPanelDirty(false)
    if (target.kind === "entry") {
      setSelectedEntryId(target.entryId)
      return
    }
    setSelectedEntryId(null)
    setEntryFilter("all")
    void applySnapshotAction(selectProject(target.projectId))
  }

  async function handleSelectBaseEnvironment(project: ProjectRecord, environment: string) {
    if (environment === project.active_base_environment) {
      return
    }

    const clearedOverrides = project.entries.filter(
      (entry) => getEntryStatus(project, entry).overridden,
    ).length
    const label = formatEnvironmentLabel(environment)
    await applySnapshotAction(
      setBaseEnvironment(project.id, environment),
      clearedOverrides > 0
        ? {
            tone: "warning",
            message: `Default set to ${label}.`,
            detail: `Cleared ${clearedOverrides} per-entry override${clearedOverrides === 1 ? "" : "s"}.`,
          }
        : { tone: "success", message: `Default set to ${label}.` },
    )
  }

  async function handleSelectEntryEnvironment(
    project: ProjectRecord,
    entry: EntryRecord,
    environment: string,
  ) {
    if (environment === getSelectedEnvironment(project, entry.id)) {
      return true
    }

    const isBase = environment === project.active_base_environment
    return applySnapshotAction(
      setEntryOverride(project.id, entry.id, isBase ? null : environment),
      {
        tone: "success",
        message: isBase
          ? `${entry.name} back on ${formatEnvironmentLabel(environment)} (default).`
          : `${entry.name} now uses ${formatEnvironmentLabel(environment)}.`,
      },
    )
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
      message,
      detail:
        "Readable by other apps until overwritten. sigyn will try to clear it in 60 seconds if unchanged.",
    })
  }

  async function handleCopyEntryName(name: string) {
    try {
      await copyText(name)
      setNotice({ tone: "success", message: `Copied ${name}.` })
    } catch (caught) {
      handleActionError(caught)
    }
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
        <ToastViewport notice={notice} error={null} onDismiss={() => setNotice(null)} />
      </main>
    )
  }

  return (
    <>
      <div className="app-shell">
        <ProjectSidebar
          projects={snapshot.projects}
          activeProjectId={activeProject?.id ?? null}
          onSelectProject={(projectId) => {
            if (projectId !== activeProject?.id) {
              requestPanelExit({ kind: "project", projectId })
            }
          }}
          showCliButton={Boolean(activeProject)}
          onShowCliDialog={() => setShowCliDialog(true)}
          onAddProject={() => setShowAddProject(true)}
          lockDisabled={busy}
          onLock={() => void handleLock()}
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
                      <div className="workspace__title">
                        <h1>{activeProject.name}</h1>
                        <button
                          className="icon-button icon-button--xs"
                          disabled={busy}
                          onClick={() => {
                            setIsRenamingProject(false)
                            setProjectNameDraft(activeProject.name)
                            setShowEditProject(true)
                          }}
                          aria-label="Edit project"
                          title="Edit project"
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    )}
                    <div className="workspace__meta">
                      <span>
                        {activeProject.entries.length}{" "}
                        {activeProject.entries.length === 1 ? "entry" : "entries"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {activeProject.supported_environments.length}{" "}
                        {activeProject.supported_environments.length === 1 ? "env" : "envs"}
                      </span>
                      {activeProject.working_directory ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span
                            className="workspace__meta-path"
                            title={`Working directory: ${activeProject.working_directory}`}
                          >
                            {activeProject.working_directory}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="header-actions">
                    <button
                      className="button button--ghost button--sm"
                      disabled={busy}
                      onClick={() => void handlePreview()}
                    >
                      <FileText size={14} />
                      Preview
                    </button>
                    <button
                      className="button button--ghost button--sm"
                      disabled={busy}
                      onClick={() => void handleCopyEffectiveEnv()}
                    >
                      <Copy size={14} />
                      Copy env
                    </button>
                    <button
                      className="button button--ghost button--sm"
                      disabled={busy}
                      onClick={() => setShowImportEntries(true)}
                    >
                      <Upload size={14} />
                      Import
                    </button>
                    <button
                      className="button button--primary button--sm"
                      disabled={busy}
                      onClick={() => setShowAddEntry(true)}
                    >
                      <Plus size={14} />
                      Add entry
                    </button>
                  </div>
                </div>

                <EnvironmentSwitcher
                  project={activeProject}
                  statuses={entryStatuses}
                  disabled={busy}
                  onSelect={(environment) =>
                    void handleSelectBaseEnvironment(activeProject, environment)
                  }
                  onReset={() =>
                    void applySnapshotAction(resetOverrides(activeProject.id), {
                      tone: "success",
                      message: `All entries back on ${formatEnvironmentLabel(activeProject.active_base_environment)}.`,
                    })
                  }
                  onShowOverrides={() => setEntryFilter("overrides")}
                />

                <div className="toolbar">
                  <label className="search">
                    <Search size={14} />
                    <input
                      ref={searchInputRef}
                      value={searchQuery}
                      placeholder="Search entries"
                      spellCheck={false}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    {searchQuery ? (
                      <button
                        className="search__clear"
                        onClick={() => {
                          setSearchQuery("")
                          searchInputRef.current?.focus()
                        }}
                        aria-label="Clear search"
                      >
                        <X size={12} />
                      </button>
                    ) : (
                      <kbd className="search__hint">/</kbd>
                    )}
                  </label>

                  <div className="filter-group" role="radiogroup" aria-label="Filter entries">
                    <FilterChip
                      label="All"
                      count={entryCounts.all}
                      active={entryFilter === "all"}
                      onClick={() => setEntryFilter("all")}
                    />
                    <FilterChip
                      label="Overridden"
                      tone="warning"
                      count={entryCounts.overrides}
                      active={entryFilter === "overrides"}
                      onClick={() => setEntryFilter("overrides")}
                    />
                    <FilterChip
                      label="Missing"
                      tone="missing"
                      count={entryCounts.missing}
                      active={entryFilter === "missing"}
                      onClick={() => setEntryFilter("missing")}
                    />
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
          </header>

          <section
            className={`workspace__content ${selectedEntry ? "workspace__content--with-panel" : ""}`}
          >
            {activeProject ? (
              <>
                {filteredEntries.length > 0 ? (
                  <EntryTable
                    project={activeProject}
                    entries={filteredEntries}
                    statuses={entryStatuses}
                    selectedEntryId={selectedEntry?.id ?? null}
                    disabled={busy}
                    onSelectEntry={(entryId) =>
                      requestPanelExit({
                        kind: "entry",
                        entryId: entryId === selectedEntryId ? null : entryId,
                      })
                    }
                    onSelectEnvironment={(entry, environment) =>
                      void handleSelectEntryEnvironment(activeProject, entry, environment)
                    }
                  />
                ) : (
                  <div className="empty-state">
                    <h2>
                      {activeProject.entries.length === 0
                        ? "No entries yet"
                        : entryFilter === "overrides" && !searchQuery
                          ? "No overridden entries"
                          : entryFilter === "missing" && !searchQuery
                            ? "No missing values"
                            : "No matching entries"}
                    </h2>
                    <p className="muted">
                      {activeProject.entries.length === 0
                        ? "Add the first entry for this project to start composing runtime envs."
                        : entryFilter === "overrides" && !searchQuery
                          ? `Every entry resolves from ${formatEnvironmentLabel(activeProject.active_base_environment)}.`
                          : entryFilter === "missing" && !searchQuery
                            ? "Every entry has a value for the environment it resolves from."
                            : "Try a different query or clear the filters."}
                    </p>
                    {activeProject.entries.length > 0 && (entryFilter !== "all" || searchQuery) ? (
                      <button
                        className="button button--ghost button--sm"
                        onClick={() => {
                          setEntryFilter("all")
                          setSearchQuery("")
                        }}
                      >
                        Show all entries
                      </button>
                    ) : null}
                  </div>
                )}

                {selectedEntry ? (
                  <EntryPanel
                    key={selectedEntry.id}
                    project={activeProject}
                    entry={selectedEntry}
                    status={entryStatuses[selectedEntry.id] ?? getEntryStatus(activeProject, selectedEntry)}
                    pendingExit={Boolean(pendingPanelExit)}
                    onConfirmExit={() => {
                      if (pendingPanelExit) {
                        performPanelExit(pendingPanelExit)
                      }
                    }}
                    onCancelExit={() => setPendingPanelExit(null)}
                    onDirtyChange={setPanelDirty}
                    onClose={() => requestPanelExit({ kind: "entry", entryId: null })}
                    onSelectEnvironment={(environment) =>
                      handleSelectEntryEnvironment(activeProject, selectedEntry, environment)
                    }
                    onSave={(input) =>
                      applySnapshotAction(updateEntry(input), {
                        tone: "success",
                        message: `${selectedEntry.name} saved.`,
                      })
                    }
                    onDelete={() =>
                      setEntryDeleteTarget({
                        projectId: activeProject.id,
                        entryId: selectedEntry.id,
                        entryName: selectedEntry.name,
                      })
                    }
                    onCopyName={() => void handleCopyEntryName(selectedEntry.name)}
                    onCopySecret={(value) => copySensitiveText(value, "Copied secret value.")}
                    onLoadError={handleActionError}
                  />
                ) : null}
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

      <CliDialog
        open={showCliDialog && Boolean(activeProject)}
        project={activeProject}
        onClose={() => setShowCliDialog(false)}
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

      <ToastViewport
        notice={notice}
        error={error}
        onDismiss={() => {
          setError(null)
          setNotice(null)
        }}
      />
    </>
  )
}

function ProjectSidebar({
  projects,
  activeProjectId,
  onSelectProject,
  showCliButton,
  onShowCliDialog,
  onAddProject,
  lockDisabled,
  onLock,
}: {
  projects: ProjectRecord[]
  activeProjectId: string | null
  onSelectProject: (projectId: string) => void
  showCliButton: boolean
  onShowCliDialog: () => void
  onAddProject: () => void
  lockDisabled: boolean
  onLock: () => void
}) {
  const [projectQuery, setProjectQuery] = useState("")
  const normalizedQuery = projectQuery.trim().toLowerCase()
  const visibleProjects = normalizedQuery
    ? projects.filter((project) => project.name.toLowerCase().includes(normalizedQuery))
    : projects

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img src={appIcon} alt="" width={22} height={22} className="sidebar__icon" />
        <div className="sidebar__title">Sigyn</div>
      </div>

      <div className="sidebar__section">
        <span className="sidebar__section-label">Projects</span>
        <button
          className="sidebar__add"
          onClick={onAddProject}
          aria-label="Add project"
          title="Add project"
        >
          <Plus size={14} />
        </button>
      </div>

      {projects.length > 0 ? (
        <label className="sidebar__search">
          <Search size={13} />
          <input
            value={projectQuery}
            placeholder="Find project"
            spellCheck={false}
            aria-label="Find project"
            onChange={(event) => setProjectQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && visibleProjects.length > 0) {
                onSelectProject(visibleProjects[0].id)
              }
              if (event.key === "Escape" && projectQuery) {
                event.preventDefault()
                setProjectQuery("")
              }
            }}
          />
          {projectQuery ? (
            <button
              className="sidebar__search-clear"
              onClick={() => setProjectQuery("")}
              aria-label="Clear project search"
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
      ) : null}

      <nav className="sidebar__nav">
        {projects.length > 0 && visibleProjects.length === 0 ? (
          <div className="sidebar__no-match">No projects match “{projectQuery.trim()}”</div>
        ) : null}
        {projects.length > 0 ? (
          visibleProjects.map((project) => (
            <button
              key={project.id}
              className={`project-link ${project.id === activeProjectId ? "project-link--active" : ""}`}
              aria-current={project.id === activeProjectId ? "page" : undefined}
              onClick={() => onSelectProject(project.id)}
            >
              <span className="project-link__name">{project.name}</span>
              <span className="project-link__count">{project.entries.length}</span>
            </button>
          ))
        ) : (
          <button className="sidebar__empty" onClick={onAddProject}>
            <Plus size={14} />
            Add your first project
          </button>
        )}
      </nav>

      <div className="sidebar__footer">
        {showCliButton ? (
          <button className="sidebar__footer-link" onClick={onShowCliDialog}>
            <Terminal size={14} />
            Companion CLI
          </button>
        ) : null}
        <button className="sidebar__footer-link" disabled={lockDisabled} onClick={onLock}>
          <Lock size={14} />
          Lock sigyn
        </button>
      </div>
    </aside>
  )
}

function CliDialog({
  open,
  project,
  onClose,
}: {
  open: boolean
  project: ProjectRecord | null
  onClose: () => void
}) {
  if (!open || !project) {
    return null
  }

  return (
    <Modal
      title="Companion CLI"
      subtitle="Run commands with the active project's resolved environment already injected."
      onClose={onClose}
    >
      <p className="muted muted--small">
        The install script puts <code>sigyn</code> on your PATH. It authenticates locally,
        reads the encrypted store directly, and injects the resolved env into the child
        command.
      </p>

      <p className="muted muted--small cli-usage-label">Usage</p>
      <code className="code-block">
        {`# uses the active project (${project.name})\nsigyn uv run python -m your_module\n\n# target a specific project\nsigyn run --project ${shellQuote(project.name)} -- uv run python -m your_module`}
      </code>
    </Modal>
  )
}

function EnvironmentSwitcher({
  project,
  statuses,
  disabled,
  onSelect,
  onReset,
  onShowOverrides,
}: {
  project: ProjectRecord
  statuses: Record<string, EntryStatus>
  disabled: boolean
  onSelect: (environment: string) => void
  onReset: () => void
  onShowOverrides: () => void
}) {
  const usageCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const status of Object.values(statuses)) {
      counts[status.environment] = (counts[status.environment] ?? 0) + 1
    }
    return counts
  }, [statuses])

  const overrideCount = Object.values(statuses).filter((status) => status.overridden).length
  const baseLabel = formatEnvironmentLabel(project.active_base_environment)

  return (
    <div className="env-switch">
      <span className="env-switch__label">Default env</span>
      <div className="env-switch__segments" role="radiogroup" aria-label="Default environment">
        {project.supported_environments.map((environment) => {
          const isDefault = environment === project.active_base_environment
          const count = usageCounts[environment] ?? 0
          const isForeign = !isDefault && count > 0

          return (
            <button
              key={environment}
              role="radio"
              aria-checked={isDefault}
              className={`env-switch__segment ${isDefault ? "env-switch__segment--active" : ""} ${
                isForeign ? "env-switch__segment--foreign" : ""
              }`}
              disabled={disabled}
              title={
                isDefault
                  ? `${count} entr${count === 1 ? "y resolves" : "ies resolve"} from ${formatEnvironmentLabel(environment)}`
                  : isForeign
                    ? `${count} entr${count === 1 ? "y is" : "ies are"} overridden to ${formatEnvironmentLabel(environment)}. Making it the default clears all overrides.`
                    : `Make ${formatEnvironmentLabel(environment)} the default`
              }
              onClick={() => onSelect(environment)}
            >
              <span>{formatEnvironmentLabel(environment)}</span>
              {count > 0 ? <span className="env-switch__count">{count}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="env-switch__status" aria-live="polite">
        {overrideCount > 0 ? (
          <>
            <button
              className="env-switch__override-link"
              onClick={onShowOverrides}
              title="Show overridden entries"
            >
              <GitBranch size={12} />
              {overrideCount} override{overrideCount === 1 ? "" : "s"}
            </button>
            <button
              className="env-switch__reset"
              disabled={disabled}
              onClick={onReset}
              title={`Point every entry back at ${baseLabel}`}
            >
              <RotateCcw size={12} />
              Reset
            </button>
          </>
        ) : (
          <span className="env-switch__clean">
            <Check size={12} />
            All entries on {baseLabel}
          </span>
        )}
      </div>
    </div>
  )
}

function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  tone?: "warning" | "missing"
  onClick: () => void
}) {
  return (
    <button
      role="radio"
      aria-checked={active}
      className={`filter-chip ${active ? "filter-chip--active" : ""} ${
        tone && count > 0 ? `filter-chip--${tone}` : ""
      }`}
      onClick={onClick}
    >
      {label}
      <span className="filter-chip__count">{count}</span>
    </button>
  )
}

function EntryTable({
  project,
  entries,
  statuses,
  selectedEntryId,
  disabled,
  onSelectEntry,
  onSelectEnvironment,
}: {
  project: ProjectRecord
  entries: EntryRecord[]
  statuses: Record<string, EntryStatus>
  selectedEntryId: string | null
  disabled: boolean
  onSelectEntry: (entryId: string) => void
  onSelectEnvironment: (entry: EntryRecord, environment: string) => void
}) {
  const abbreviations = useMemo(
    () => abbreviateEnvironments(project.supported_environments),
    [project.supported_environments],
  )
  const tableStyle = {
    "--env-count": project.supported_environments.length,
  } as CSSProperties

  return (
    <div className="entry-table" role="table" aria-label="Entries" style={tableStyle}>
      <div className="entry-table__head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader" className="entry-table__notes-head">
          Description
        </span>
        <span role="columnheader" className="env-matrix env-matrix--head">
          {project.supported_environments.map((environment) => (
            <span
              key={environment}
              className={`env-matrix__label ${
                environment === project.active_base_environment ? "env-matrix__label--default" : ""
              }`}
              title={
                environment === project.active_base_environment
                  ? `${formatEnvironmentLabel(environment)} (default)`
                  : formatEnvironmentLabel(environment)
              }
            >
              {abbreviations[environment]}
            </span>
          ))}
        </span>
      </div>

      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          project={project}
          entry={entry}
          status={statuses[entry.id] ?? getEntryStatus(project, entry)}
          selected={entry.id === selectedEntryId}
          disabled={disabled}
          onSelect={() => onSelectEntry(entry.id)}
          onSelectEnvironment={(environment) => onSelectEnvironment(entry, environment)}
        />
      ))}
    </div>
  )
}

function EntryRow({
  project,
  entry,
  status,
  selected,
  disabled,
  onSelect,
  onSelectEnvironment,
}: {
  project: ProjectRecord
  entry: EntryRecord
  status: EntryStatus
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onSelectEnvironment: (environment: string) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const valueEnvironments = useMemo(
    () => new Set(entry.values.map((value) => value.environment)),
    [entry.values],
  )

  useEffect(() => {
    if (!selected || !rowRef.current) {
      return
    }
    rowRef.current.scrollIntoView({ block: "nearest" })
    const focused = document.activeElement
    if (!focused || focused === document.body || focused.classList.contains("entry-row")) {
      rowRef.current.focus({ preventScroll: true })
    }
  }, [selected])

  return (
    <div
      ref={rowRef}
      role="row"
      tabIndex={0}
      aria-selected={selected}
      className={`entry-row ${selected ? "entry-row--selected" : ""} ${
        status.overridden ? "entry-row--override" : ""
      } ${status.missing ? "entry-row--missing" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <div role="cell" className="entry-row__name">
        <span className="mono" title={describeEntryStatus(project, entry, status)}>
          {entry.name}
        </span>
      </div>

      <div role="cell" className="entry-row__notes">
        {entry.category ? <span className="category-tag">{entry.category}</span> : null}
        {entry.description ? (
          <span className="entry-row__description" title={entry.description}>
            {entry.description}
          </span>
        ) : null}
      </div>

      <div role="cell" className="env-matrix">
        {project.supported_environments.map((environment) => {
          const hasValue = valueEnvironments.has(environment)
          const isActive = environment === status.environment
          const label = formatEnvironmentLabel(environment)
          const stateClass = isActive
            ? status.missing
              ? "env-cell--active-missing"
              : status.overridden
                ? "env-cell--active-override"
                : "env-cell--active"
            : ""

          return (
            <button
              key={environment}
              className={`env-cell ${hasValue ? "env-cell--set" : "env-cell--empty"} ${stateClass}`}
              disabled={disabled}
              aria-pressed={isActive}
              aria-label={`${label}: ${hasValue ? "value set" : "no value"}${
                isActive ? ", in use" : `. Use ${label} for ${entry.name}`
              }`}
              title={`${label} · ${hasValue ? "value set" : "no value"}${
                isActive ? " · in use" : " · click to use"
              }`}
              onClick={(event) => {
                event.stopPropagation()
                if (!isActive) {
                  onSelectEnvironment(environment)
                }
              }}
            >
              <span className="env-cell__mark" aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EntryPanel({
  project,
  entry,
  status,
  pendingExit,
  onConfirmExit,
  onCancelExit,
  onDirtyChange,
  onClose,
  onSelectEnvironment,
  onSave,
  onDelete,
  onCopyName,
  onCopySecret,
  onLoadError,
}: {
  project: ProjectRecord
  entry: EntryRecord
  status: EntryStatus
  pendingExit: boolean
  onConfirmExit: () => void
  onCancelExit: () => void
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onSelectEnvironment: (environment: string) => Promise<boolean>
  onSave: (input: UpdateEntryInput) => Promise<boolean>
  onDelete: () => void
  onCopyName: () => void
  onCopySecret: (value: string) => Promise<void>
  onLoadError: (caught: unknown) => void
}) {
  const [saving, setSaving] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [valuesLoaded, setValuesLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [draftName, setDraftName] = useState(entry.name)
  const [draftCategory, setDraftCategory] = useState(entry.category ?? "")
  const [draftDescription, setDraftDescription] = useState(entry.description ?? "")
  const [draftValues, setDraftValues] = useState<Record<string, ValueDraft>>(() =>
    buildEntryDraftValues(project, entry),
  )
  const [baselineValues, setBaselineValues] = useState<Record<string, ValueDraft>>(() =>
    buildEntryDraftValues(project, entry),
  )
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [valueFocused, setValueFocused] = useState<Record<string, boolean>>({})
  const dirtyRef = useRef(false)
  const syncedSignatureRef = useRef(getEntrySignature(entry))

  const signature = getEntrySignature(entry)
  const metaDirty =
    draftName !== entry.name ||
    draftCategory !== (entry.category ?? "") ||
    draftDescription !== (entry.description ?? "")
  const valuesDirty =
    valuesLoaded &&
    project.supported_environments.some((environment) => {
      const draft = draftValues[environment] ?? EMPTY_VALUE_DRAFT
      const baseline = baselineValues[environment] ?? EMPTY_VALUE_DRAFT
      return draft.present !== baseline.present || (draft.present && draft.value !== baseline.value)
    })
  const dirty = metaDirty || valuesDirty

  useEffect(() => {
    let cancelled = false
    const initial = buildEntryDraftValues(project, entry)
    syncedSignatureRef.current = getEntrySignature(entry)
    setDraftName(entry.name)
    setDraftCategory(entry.category ?? "")
    setDraftDescription(entry.description ?? "")
    setDraftValues(initial)
    setBaselineValues(initial)
    setRevealed({})
    setValuesLoaded(false)
    setLoadFailed(false)

    getEntryValues(project.id, entry.id)
      .then((result) => {
        if (cancelled) {
          return
        }
        const loaded = { ...initial }
        for (const item of result.values) {
          loaded[item.environment] = { present: true, value: item.value }
        }
        setDraftValues(loaded)
        setBaselineValues(loaded)
        setValuesLoaded(true)
      })
      .catch((caught) => {
        if (cancelled) {
          return
        }
        setLoadFailed(true)
        onLoadError(caught)
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  useEffect(() => {
    dirtyRef.current = dirty
    onDirtyChange(dirty)
  }, [dirty])

  useEffect(() => () => onDirtyChange(false), [])

  useEffect(() => {
    // Pick up external edits (CLI, import) when there is nothing local to lose.
    if (signature !== syncedSignatureRef.current && !dirtyRef.current) {
      setReloadToken((current) => current + 1)
    }
  }, [signature])

  async function handleSave() {
    if (!dirty || saving || !valuesLoaded) {
      return
    }

    setSaving(true)
    try {
      const saved = await onSave({
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
      if (saved) {
        setReloadToken((current) => current + 1)
      }
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    setDraftName(entry.name)
    setDraftCategory(entry.category ?? "")
    setDraftDescription(entry.description ?? "")
    setDraftValues(baselineValues)
    setRevealed({})
  }

  const activeLabel = formatEnvironmentLabel(status.environment)
  const baseLabel = formatEnvironmentLabel(project.active_base_environment)

  return (
    <aside
      className="entry-panel"
      aria-label={`${entry.name} details`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault()
          void handleSave()
        }
      }}
    >
      <header className="entry-panel__header">
        <div className="entry-panel__title">
          <h2 className="mono" title={entry.name}>
            {entry.name}
          </h2>
          {entry.category || entry.description ? (
            <p className="entry-panel__subtitle">
              {entry.category ? <span className="category-tag">{entry.category}</span> : null}
              {entry.description ? <span>{entry.description}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="entry-panel__header-actions">
          <button
            className="icon-button icon-button--sm"
            onClick={onCopyName}
            aria-label="Copy name"
            title="Copy name"
          >
            <Copy size={14} />
          </button>
          <button
            className="icon-button icon-button--sm"
            onClick={onClose}
            aria-label="Close panel"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div
        className={`source-callout ${
          status.missing
            ? "source-callout--missing"
            : status.overridden
              ? "source-callout--override"
              : ""
        }`}
      >
        {status.missing ? <AlertTriangle size={14} /> : status.overridden ? <GitBranch size={14} /> : <Check size={14} />}
        <span className="source-callout__text">
          {status.missing ? (
            <>
              No value for <strong>{activeLabel}</strong>. This entry is skipped when the env is
              resolved.
            </>
          ) : status.overridden ? (
            <>
              Overridden to <strong>{activeLabel}</strong> instead of the default{" "}
              <strong>{baseLabel}</strong>.
            </>
          ) : (
            <>
              Resolves from <strong>{activeLabel}</strong>, the project default.
            </>
          )}
        </span>
        {status.overridden ? (
          <button
            className="source-callout__action"
            disabled={saving}
            onClick={() => void onSelectEnvironment(project.active_base_environment)}
          >
            Use {baseLabel}
          </button>
        ) : null}
      </div>

      {pendingExit ? (
        <div className="entry-panel__confirm" role="alert">
          <span>Discard unsaved changes to {entry.name}?</span>
          <div className="entry-panel__confirm-actions">
            <button className="button button--ghost button--xs" onClick={onCancelExit}>
              Keep editing
            </button>
            <button className="button button--danger button--xs" onClick={onConfirmExit}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      <div className="entry-panel__body">
        <section className="entry-panel__section">
          <div className="panel-section-label">
            <span>Values</span>
            <span className="panel-section-label__hint">select which one this entry uses</span>
          </div>
          <div className="panel-values" role="radiogroup" aria-label={`Source for ${entry.name}`}>
            {project.supported_environments.map((environment) => {
              const draft = draftValues[environment] ?? EMPTY_VALUE_DRAFT
              const isActive = status.environment === environment
              const isDefault = environment === project.active_base_environment
              const isMasked = draft.present && !revealed[environment]

              return (
                <div
                  key={environment}
                  className={`panel-value ${isActive ? "panel-value--active" : ""} ${
                    isActive && status.overridden ? "panel-value--override" : ""
                  } ${isActive && !draft.present ? "panel-value--missing" : ""}`}
                >
                  <button
                    role="radio"
                    aria-checked={isActive}
                    className="panel-value__source"
                    disabled={saving}
                    title={isActive ? "In use" : `Use ${formatEnvironmentLabel(environment)}`}
                    onClick={() => void onSelectEnvironment(environment)}
                  >
                    <span className="panel-value__radio" aria-hidden="true" />
                    <span className="panel-value__env">{formatEnvironmentLabel(environment)}</span>
                    {isDefault ? <span className="panel-value__default">default</span> : null}
                  </button>

                  <input
                    className={`panel-value__input ${isMasked ? "panel-value__input--masked" : ""}`}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${formatEnvironmentLabel(environment)} value`}
                    disabled={saving || !valuesLoaded}
                    readOnly={isMasked}
                    value={
                      isMasked
                        ? OBSCURED_SECRET_MASK
                        : valueFocused[environment]
                          ? draft.value
                          : displayWhitespace(draft.value)
                    }
                    placeholder={
                      !valuesLoaded ? (loadFailed ? "failed to load" : "loading…") : "not set"
                    }
                    onFocus={(event) => {
                      setValueFocused((current) => ({ ...current, [environment]: true }))
                      if (isMasked) {
                        setRevealed((current) => ({ ...current, [environment]: true }))
                        // The click landed on the mask, so put the caret at the end of the real value.
                        const input = event.currentTarget
                        requestAnimationFrame(() => {
                          input.setSelectionRange(input.value.length, input.value.length)
                        })
                      }
                    }}
                    onBlur={() => {
                      setValueFocused((current) => ({ ...current, [environment]: false }))
                    }}
                    onChange={(event) => {
                      setDraftValues((current) => ({
                        ...current,
                        [environment]: { present: true, value: event.target.value },
                      }))
                      setRevealed((current) => ({ ...current, [environment]: true }))
                    }}
                  />

                  <div className="panel-value__actions">
                    <button
                      className="icon-button icon-button--xs"
                      disabled={!draft.present || saving || !valuesLoaded}
                      onClick={() =>
                        setRevealed((current) => ({
                          ...current,
                          [environment]: !current[environment],
                        }))
                      }
                      aria-label={revealed[environment] ? "Hide value" : "Reveal value"}
                      title={revealed[environment] ? "Hide" : "Reveal"}
                    >
                      {revealed[environment] ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      className="icon-button icon-button--xs"
                      disabled={!draft.present || saving || !valuesLoaded}
                      onClick={() => void onCopySecret(draft.value)}
                      aria-label="Copy value"
                      title="Copy value"
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      className="icon-button icon-button--xs"
                      disabled={!draft.present || saving || !valuesLoaded}
                      onClick={() =>
                        setDraftValues((current) => ({
                          ...current,
                          [environment]: { present: false, value: "" },
                        }))
                      }
                      aria-label="Remove value"
                      title="Remove value"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {loadFailed ? (
            <button
              className="button button--ghost button--xs entry-panel__retry"
              onClick={() => setReloadToken((current) => current + 1)}
            >
              <RotateCcw size={12} />
              Retry loading values
            </button>
          ) : null}
        </section>

        <section className="entry-panel__section">
          <div className="panel-section-label">
            <span>Details</span>
          </div>
          <div className="entry-panel__fields">
            <label>
              <span>Name</span>
              <input
                className="input"
                value={draftName}
                disabled={saving}
                spellCheck={false}
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
          <label>
            <span>Description</span>
            <textarea
              className="textarea"
              value={draftDescription}
              disabled={saving}
              placeholder="optional"
              onChange={(event) => setDraftDescription(event.target.value)}
            />
          </label>
        </section>
      </div>

      <footer className="entry-panel__footer">
        <button
          className="button button--danger button--xs"
          disabled={saving}
          onClick={onDelete}
          title="Delete entry"
        >
          <Trash2 size={13} />
          Delete
        </button>
        <div className="entry-panel__footer-main">
          {dirty ? <span className="unsaved-pill">Unsaved</span> : null}
          <button
            className="button button--ghost button--xs"
            disabled={!dirty || saving}
            onClick={handleDiscard}
          >
            Discard
          </button>
          <button
            className="button button--primary button--xs"
            disabled={!dirty || saving || !valuesLoaded}
            onClick={() => void handleSave()}
            title="Save (⌘S)"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </aside>
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
  const [environmentTags, setEnvironmentTags] = useState(() =>
    parseEnvironmentList(initialEnvironmentText),
  )
  const [environmentDraft, setEnvironmentDraft] = useState("")
  const [workingDirectory, setWorkingDirectory] = useState(initialWorkingDirectory)

  useEffect(() => {
    if (open) {
      setName(initialName)
      setEnvironmentTags(parseEnvironmentList(initialEnvironmentText))
      setEnvironmentDraft("")
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

      <div className="form-field">
        <span>Supported environments</span>
        <div className="tag-input">
          {environmentTags.map((environment) => (
            <span key={environment} className="tag-input__tag">
              {formatEnvironmentLabel(environment)}
              <button
                type="button"
                className="tag-input__remove"
                disabled={busy}
                onClick={() =>
                  setEnvironmentTags((current) =>
                    current.filter((currentEnvironment) => currentEnvironment !== environment),
                  )
                }
                aria-label={`Remove ${formatEnvironmentLabel(environment)}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            className="tag-input__input"
            value={environmentDraft}
            disabled={busy}
            placeholder={environmentTags.length > 0 ? "Add environment" : "local"}
            spellCheck={false}
            onBlur={() => {
              setEnvironmentTags((current) => mergeEnvironmentTags(current, environmentDraft))
              setEnvironmentDraft("")
            }}
            onChange={(event) => setEnvironmentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault()
                setEnvironmentTags((current) => mergeEnvironmentTags(current, environmentDraft))
                setEnvironmentDraft("")
              }

              if (
                event.key === "Backspace" &&
                environmentDraft.length === 0 &&
                environmentTags.length > 0
              ) {
                setEnvironmentTags((current) => current.slice(0, -1))
              }
            }}
          />
        </div>
      </div>
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
              environmentText: mergeEnvironmentTags(environmentTags, environmentDraft).join(", "),
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

function ToastViewport({
  notice,
  error,
  onDismiss,
}: {
  notice: ToastNotice | null
  error: string | null
  onDismiss: () => void
}) {
  const toast = error
    ? { key: `error:${error}`, tone: "danger" as const, message: error, detail: undefined }
    : notice
      ? { key: `notice:${notice.id}`, tone: notice.tone, message: notice.message, detail: notice.detail }
      : null

  return (
    <div className="toast-viewport" aria-live={error ? "assertive" : "polite"}>
      {toast ? (
        <div
          key={toast.key}
          className={`toast toast--${toast.tone}`}
          role={toast.tone === "danger" ? "alert" : "status"}
        >
          <span className="toast__icon" aria-hidden="true">
            {toast.tone === "warning" ? <AlertTriangle size={15} /> : null}
            {toast.tone === "success" ? <Check size={15} /> : null}
            {toast.tone === "danger" ? <X size={15} /> : null}
          </span>
          <div className="toast__text">
            <span className="toast__message">{toast.message}</span>
            {toast.detail ? <span className="toast__detail">{toast.detail}</span> : null}
          </div>
          <button className="toast__close" onClick={onDismiss} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function getEntryStatus(project: ProjectRecord, entry: EntryRecord): EntryStatus {
  const environment = getSelectedEnvironment(project, entry.id)
  return {
    environment,
    overridden: environment !== project.active_base_environment,
    missing: !entry.values.some((value) => value.environment === environment),
  }
}

function describeEntryStatus(project: ProjectRecord, entry: EntryRecord, status: EntryStatus) {
  const label = formatEnvironmentLabel(status.environment)
  if (status.missing) {
    return `${entry.name}: no value for ${label}, so it is skipped`
  }
  if (status.overridden) {
    return `${entry.name}: overridden to ${label} (default ${formatEnvironmentLabel(project.active_base_environment)})`
  }
  return entry.name
}

function getEntrySignature(entry: EntryRecord) {
  return JSON.stringify([
    entry.name,
    entry.category,
    entry.description,
    entry.values.map((value) => value.environment),
  ])
}

function abbreviateEnvironments(environments: string[]) {
  const result: Record<string, string> = {}
  const used = new Set<string>()

  for (const environment of environments) {
    const compact = environment.replace(/[^a-z0-9]/gi, "").toUpperCase() || environment.toUpperCase()
    let abbreviation = ENV_ABBREVIATIONS[environment] ?? compact.slice(0, 3)
    let length = 3
    while (used.has(abbreviation) && length < Math.min(compact.length, 4)) {
      length += 1
      abbreviation = compact.slice(0, length)
    }
    let suffix = 2
    const stem = abbreviation.slice(0, 3)
    while (used.has(abbreviation)) {
      abbreviation = `${stem}${suffix}`
      suffix += 1
    }
    used.add(abbreviation)
    result[environment] = abbreviation
  }

  return result
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

function mergeEnvironmentTags(environments: string[], draft: string) {
  const next = [...environments]
  for (const environment of parseEnvironmentList(draft)) {
    if (!next.includes(environment)) {
      next.push(environment)
    }
  }
  return next
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
