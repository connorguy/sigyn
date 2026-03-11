mod cli;
mod error;
mod ipc;
mod macos_auth;
mod model;
mod store;

use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use error::AppError;
use zeroize::Zeroize;
use model::{
    AppSnapshot, CreateEntryInput, CreateProjectInput, DeleteEntryInput, DeleteProjectInput,
    EntryValuesResult, GetEntryValuesInput, ImportEntriesInput, ImportEntriesResult,
    PreviewProjectInput, PreviewResult, ProjectRecord, RenameProjectInput, ResetOverridesInput,
    SelectProjectInput, SetBaseEnvironmentInput, SetEntryOverrideInput, UpdateEntryInput,
    UpdateProjectInput,
};
use store::Store;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};

pub use crate::cli::run_cli;

type CommandResult<T> = Result<T, String>;
const TRAY_ID: &str = "main";
const SNAPSHOT_UPDATED_EVENT: &str = "snapshot-updated";
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SESSION_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(15);
const MENU_ITEM_OPEN: &str = "open";
const MENU_ITEM_QUIT: &str = "quit";
const MENU_ITEM_LOCK: &str = "lock";
const MENU_ITEM_UNLOCK: &str = "unlock";
const MENU_ITEM_NO_PROJECTS: &str = "no-projects";
const MENU_ITEM_PROJECT_SUBMENU: &str = "projects";
const MENU_ITEM_PROJECT_PREFIX: &str = "project:";
const MENU_ITEM_ENVIRONMENT_SUBMENU: &str = "environment";
const MENU_ITEM_ENV_PREFIX: &str = "environment:";
const MENU_ITEM_RESET_OVERRIDES: &str = "reset-overrides";
const MENU_ITEM_MIXED_LABEL: &str = "mixed-label";

struct SessionCache {
    key: Option<Vec<u8>>,
    last_activity: Option<Instant>,
}

struct SessionState {
    cache: Mutex<SessionCache>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            cache: Mutex::new(SessionCache {
                key: None,
                last_activity: None,
            }),
        }
    }

    fn is_unlocked(&self) -> bool {
        self.expire_if_idle();
        self.cache.lock().expect("session mutex poisoned").key.is_some()
    }

    fn store_key(&self, key: Vec<u8>) {
        let mut cache = self.cache.lock().expect("session mutex poisoned");
        cache.key = Some(key);
        cache.last_activity = Some(Instant::now());
    }

    fn cloned_key(&self) -> Option<Vec<u8>> {
        self.expire_if_idle();
        self.cache.lock().expect("session mutex poisoned").key.clone()
    }

    fn touch(&self) -> bool {
        let mut cache = self.cache.lock().expect("session mutex poisoned");
        if cache.key.is_some() {
            cache.last_activity = Some(Instant::now());
            true
        } else {
            false
        }
    }

    fn lock(&self) {
        let mut cache = self.cache.lock().expect("session mutex poisoned");
        Self::clear_locked(&mut cache);
    }

    fn expire_if_idle(&self) -> bool {
        let mut cache = self.cache.lock().expect("session mutex poisoned");
        let expired = cache
            .last_activity
            .map(|last_activity| last_activity.elapsed() >= SESSION_IDLE_TIMEOUT)
            .unwrap_or(false);
        if expired {
            Self::clear_locked(&mut cache);
        }
        expired
    }

    fn clear_locked(cache: &mut SessionCache) {
        if let Some(ref mut key) = cache.key {
            key.zeroize();
        }
        cache.key = None;
        cache.last_activity = None;
    }
}

pub struct AppRuntime {
    store: Store,
    session: Arc<SessionState>,
    unlock_lock: Mutex<()>,
}

impl AppRuntime {
    fn new() -> Result<Self, AppError> {
        Ok(Self {
            store: Store::new()?,
            session: Arc::new(SessionState::new()),
            unlock_lock: Mutex::new(()),
        })
    }

    fn snapshot(&self) -> Result<AppSnapshot, AppError> {
        if self.session.is_unlocked() {
            self.session.touch();
            self.store.load_snapshot()
        } else {
            self.store.load_locked_snapshot()
        }
    }

    fn locked_snapshot(&self) -> AppSnapshot {
        self.store
            .load_locked_snapshot()
            .unwrap_or_else(|_| AppSnapshot::locked())
    }

    fn unlock(&self) -> Result<AppSnapshot, AppError> {
        self.ensure_unlocked()?;
        self.store.load_snapshot()
    }

    fn ensure_unlocked(&self) -> Result<(), AppError> {
        let _unlock_guard = self.unlock_lock.lock().expect("unlock mutex poisoned");
        if self.session.is_unlocked() {
            self.session.touch();
            return Ok(());
        }

        let key = macos_auth::authenticate_and_load_master_key(&self.store)?;
        self.session.store_key(key);
        Ok(())
    }

    fn lock(&self) {
        self.session.lock();
    }

    fn with_unlocked<T>(
        &self,
        operation: impl FnOnce(&Store, &[u8]) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut key = self.session.cloned_key().ok_or(AppError::Locked)?;
        let result = operation(&self.store, &key);
        key.zeroize();
        self.session.touch();
        result
    }

    fn refresh_activity(&self) -> bool {
        self.session.expire_if_idle();
        self.session.touch()
    }

    fn session_state(&self) -> Arc<SessionState> {
        Arc::clone(&self.session)
    }
}

#[tauri::command]
fn get_snapshot(app: AppHandle, state: State<'_, AppRuntime>) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.snapshot())
}

#[tauri::command]
fn unlock_app(app: AppHandle, state: State<'_, AppRuntime>) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.unlock())
}

#[tauri::command]
fn lock_app(app: AppHandle, state: State<'_, AppRuntime>) -> CommandResult<AppSnapshot> {
    state.lock();
    sync_snapshot_result(&app, state.snapshot())
}

#[tauri::command]
fn touch_session(state: State<'_, AppRuntime>) -> CommandResult<()> {
    if state.refresh_activity() {
        Ok(())
    } else {
        Err(AppError::Locked.to_string())
    }
}

#[tauri::command]
fn create_project(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: CreateProjectInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.create_project(input)))
}

#[tauri::command]
fn rename_project(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: RenameProjectInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.rename_project(input)))
}

#[tauri::command]
fn update_project(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: UpdateProjectInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.update_project(input)))
}

#[tauri::command]
fn delete_project(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: DeleteProjectInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.delete_project(input)))
}

#[tauri::command]
fn select_project(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: SelectProjectInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.select_project(input)))
}

#[tauri::command]
fn set_base_environment(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: SetBaseEnvironmentInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.set_base_environment(input)))
}

#[tauri::command]
fn reset_overrides(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: ResetOverridesInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.reset_overrides(input)))
}

#[tauri::command]
fn set_entry_override(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: SetEntryOverrideInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.set_entry_override(input)))
}

#[tauri::command]
fn create_entry(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: CreateEntryInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, key| store.create_entry(input, key)))
}

#[tauri::command]
fn update_entry(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: UpdateEntryInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, key| store.update_entry(input, key)))
}

#[tauri::command]
fn delete_entry(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: DeleteEntryInput,
) -> CommandResult<AppSnapshot> {
    sync_snapshot_result(&app, state.with_unlocked(|store, _| store.delete_entry(input)))
}

#[tauri::command]
fn import_entries(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    input: ImportEntriesInput,
) -> CommandResult<ImportEntriesResult> {
    state
        .with_unlocked(|store, key| store.import_entries(input, key))
        .map(|result| {
            sync_tray(&app, &result.snapshot);
            result
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn preview_project(
    state: State<'_, AppRuntime>,
    input: PreviewProjectInput,
) -> CommandResult<PreviewResult> {
    state
        .with_unlocked(|store, key| store.preview_project(&input.project_id, key))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn get_entry_values(
    state: State<'_, AppRuntime>,
    input: GetEntryValuesInput,
) -> CommandResult<EntryValuesResult> {
    state
        .with_unlocked(|store, key| store.get_entry_values(&input.project_id, &input.entry_id, key))
        .map_err(|err| err.to_string())
}

fn sync_snapshot_result(
    app: &AppHandle,
    result: Result<AppSnapshot, AppError>,
) -> CommandResult<AppSnapshot> {
    result
        .map(|snapshot| {
            sync_tray(app, &snapshot);
            snapshot
        })
        .map_err(|err| err.to_string())
}

fn sync_tray(app: &AppHandle, snapshot: &AppSnapshot) {
    update_tray_title(app, snapshot);
    update_tray_menu(app, snapshot);
}

fn start_idle_monitor(app: AppHandle, session: Arc<SessionState>) -> Result<(), AppError> {
    thread::Builder::new()
        .name("sigyn-session-monitor".into())
        .spawn(move || loop {
            thread::sleep(SESSION_IDLE_CHECK_INTERVAL);
            if session.expire_if_idle() {
                let snapshot = app.state::<AppRuntime>().locked_snapshot();
                sync_tray(&app, &snapshot);
                emit_snapshot_updated(&app, &snapshot);
            }
        })
        .map(|_| ())
        .map_err(Into::into)
}

fn tray_title(snapshot: &AppSnapshot) -> String {
    let lock = if snapshot.locked { "\u{1F512} " } else { "" };
    if let Some(project) = active_project(snapshot) {
        let override_count = project.entry_overrides.len();
        if override_count > 0 {
            format!(
                "{lock}[{} | {} +{}]",
                project.name, project.active_base_environment, override_count
            )
        } else {
            format!(
                "{lock}[{} | {}]",
                project.name, project.active_base_environment
            )
        }
    } else {
        format!("{lock}[sigyn]")
    }
}

fn update_tray_title(app: &AppHandle, snapshot: &AppSnapshot) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(tray_title(snapshot)));
    }
}

fn update_tray_menu(app: &AppHandle, snapshot: &AppSnapshot) {
    let Ok(menu) = build_tray_menu(app, snapshot) else {
        return;
    };

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn emit_snapshot_updated(app: &AppHandle, snapshot: &AppSnapshot) {
    let _ = app.emit(SNAPSHOT_UPDATED_EVENT, snapshot.clone());
}

fn active_project(snapshot: &AppSnapshot) -> Option<&ProjectRecord> {
    snapshot
        .active_project_id
        .as_ref()
        .and_then(|active_id| snapshot.projects.iter().find(|project| &project.id == active_id))
        .or_else(|| snapshot.projects.first())
}

fn build_project_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
    snapshot: &AppSnapshot,
) -> tauri::Result<Submenu<R>> {
    let active_id = snapshot.active_project_id.as_deref();
    let submenu = Submenu::with_id(app, MENU_ITEM_PROJECT_SUBMENU, "Projects", true)?;

    for project in &snapshot.projects {
        let is_active = active_id.map_or(false, |id| id == project.id);
        let item = CheckMenuItem::with_id(
            app,
            format!("{MENU_ITEM_PROJECT_PREFIX}{}", project.id),
            &project.name,
            true,
            is_active,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }

    Ok(submenu)
}

fn build_environment_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
    project: &ProjectRecord,
) -> tauri::Result<Submenu<R>> {
    let submenu = Submenu::with_id(
        app,
        MENU_ITEM_ENVIRONMENT_SUBMENU,
        "Environment",
        true,
    )?;

    for environment in &project.supported_environments {
        let item = CheckMenuItem::with_id(
            app,
            format!("{MENU_ITEM_ENV_PREFIX}{environment}"),
            environment,
            true,
            environment == &project.active_base_environment,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }

    Ok(submenu)
}

fn build_tray_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
    snapshot: &AppSnapshot,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    if snapshot.locked {
        let unlock_item = MenuItem::with_id(app, MENU_ITEM_UNLOCK, "Unlock", true, None::<&str>)?;
        menu.append(&unlock_item)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    } else if let Some(project) = active_project(snapshot) {
        let project_menu = build_project_menu(app, snapshot)?;
        let environment_menu = build_environment_menu(app, project)?;
        menu.append(&project_menu)?;
        menu.append(&environment_menu)?;

        let override_count = project.entry_overrides.len();
        if override_count > 0 {
            let mixed_label = MenuItem::with_id(
                app,
                MENU_ITEM_MIXED_LABEL,
                format!(
                    "Mixed — {} override{}",
                    override_count,
                    if override_count == 1 { "" } else { "s" }
                ),
                false,
                None::<&str>,
            )?;
            menu.append(&mixed_label)?;

            let reset_item = MenuItem::with_id(
                app,
                MENU_ITEM_RESET_OVERRIDES,
                "Reset Overrides",
                true,
                None::<&str>,
            )?;
            menu.append(&reset_item)?;
        }

        menu.append(&PredefinedMenuItem::separator(app)?)?;
    } else {
        let no_projects_item = MenuItem::with_id(
            app,
            MENU_ITEM_NO_PROJECTS,
            "No projects configured",
            false,
            None::<&str>,
        )?;
        menu.append(&no_projects_item)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    let open_item = MenuItem::with_id(app, MENU_ITEM_OPEN, "Open sigyn", true, None::<&str>)?;
    menu.append(&open_item)?;

    if !snapshot.locked {
        let lock_item = MenuItem::with_id(app, MENU_ITEM_LOCK, "Lock", true, None::<&str>)?;
        menu.append(&lock_item)?;
    }

    let quit_item = MenuItem::with_id(app, MENU_ITEM_QUIT, "Quit", true, None::<&str>)?;
    menu.append(&quit_item)?;

    Ok(menu)
}

fn handle_tray_menu_action(app: &AppHandle, event_id: &str) -> Result<(), AppError> {
    match event_id {
        MENU_ITEM_OPEN => {
            show_main_window(app);
        }
        MENU_ITEM_QUIT => app.exit(0),
        MENU_ITEM_LOCK => {
            let state = app.state::<AppRuntime>();
            state.lock();
            let snapshot = state.snapshot()?;
            sync_tray(app, &snapshot);
            emit_snapshot_updated(app, &snapshot);
        }
        MENU_ITEM_UNLOCK => {
            let state = app.state::<AppRuntime>();
            let snapshot = state.unlock()?;
            sync_tray(app, &snapshot);
            emit_snapshot_updated(app, &snapshot);
        }
        MENU_ITEM_RESET_OVERRIDES => {
            handle_tray_reset_overrides(app)?;
        }
        _ => {
            if let Some(environment) = event_id.strip_prefix(MENU_ITEM_ENV_PREFIX) {
                handle_tray_environment_selection(app, environment)?;
            } else if let Some(project_id) = event_id.strip_prefix(MENU_ITEM_PROJECT_PREFIX) {
                handle_tray_project_selection(app, project_id)?;
            }
        }
    }

    Ok(())
}

fn handle_tray_project_selection(app: &AppHandle, project_id: &str) -> Result<(), AppError> {
    let state = app.state::<AppRuntime>();
    let snapshot = state.with_unlocked(|store, _| {
        store.select_project(SelectProjectInput {
            project_id: project_id.to_string(),
        })
    })?;

    sync_tray(app, &snapshot);
    emit_snapshot_updated(app, &snapshot);

    Ok(())
}

fn handle_tray_environment_selection(app: &AppHandle, environment: &str) -> Result<(), AppError> {
    let state = app.state::<AppRuntime>();
    let current_snapshot = state.unlock()?;
    let project = active_project(&current_snapshot)
        .ok_or_else(|| AppError::NotFound("no active project".into()))?;

    if project.active_base_environment == environment {
        return Ok(());
    }

    let snapshot = state.with_unlocked(|store, _| {
        store.set_base_environment(SetBaseEnvironmentInput {
            project_id: project.id.clone(),
            environment: environment.to_string(),
        })
    })?;

    sync_tray(app, &snapshot);
    emit_snapshot_updated(app, &snapshot);

    Ok(())
}

fn handle_tray_reset_overrides(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppRuntime>();
    let current_snapshot = state.snapshot()?;
    let project = active_project(&current_snapshot)
        .ok_or_else(|| AppError::NotFound("no active project".into()))?;

    let snapshot = state.with_unlocked(|store, _| {
        store.reset_overrides(ResetOverridesInput {
            project_id: project.id.clone(),
        })
    })?;

    sync_tray(app, &snapshot);
    emit_snapshot_updated(app, &snapshot);

    Ok(())
}

pub fn run_app() {
    tauri::Builder::default()
        .manage(AppRuntime::new().expect("failed to initialize app runtime"))
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            unlock_app,
            lock_app,
            touch_session,
            create_project,
            rename_project,
            update_project,
            delete_project,
            select_project,
            set_base_environment,
            reset_overrides,
            set_entry_override,
            create_entry,
            update_entry,
            delete_entry,
            import_entries,
            preview_project,
            get_entry_values
        ])
        .setup(|app| {
            build_tray(app)?;
            let session = app.state::<AppRuntime>().session_state();
            start_idle_monitor(app.handle().clone(), session)?;
            ipc::start_server(&app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri application error");
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let snapshot = app
        .state::<AppRuntime>()
        .snapshot()
        .unwrap_or_else(|_| AppSnapshot::locked());
    let menu = build_tray_menu(app.handle(), &snapshot)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .title(tray_title(&snapshot))
        .menu(&menu)
        .on_menu_event(|app, event| {
            let _ = handle_tray_menu_action(app, event.id.as_ref());
        })
        .build(app)?;

    sync_tray(app.handle(), &snapshot);

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
