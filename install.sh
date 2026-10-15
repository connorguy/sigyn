#!/usr/bin/env bash
set -euo pipefail

# ── sigyn install script ──────────────────────────────────────────────
# Builds the Tauri app and CLI from source, installs sigyn.app into
# /Applications, and symlinks the CLI binary onto PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/connorguy/sigyn/main/install.sh | bash
#   ./install.sh            # build + install from this checkout
#   ./install.sh --no-build # skip build, install from existing artifacts
#
# When run outside a sigyn checkout (e.g. piped from curl), the script
# fetches the source into SIGYN_SOURCE_DIR and re-runs itself from there.
#   SIGYN_REF         branch or tag to install (default: main)
#   SIGYN_SOURCE_DIR  where to keep the source (default: ~/Library/Caches/sigyn/source)
# ──────────────────────────────────────────────────────────────────────

APP_NAME="sigyn"
APP_BUNDLE="${APP_NAME}.app"
INSTALL_DIR="/Applications"
CLI_LINK_DIR="${HOME}/.local/bin"
CLI_BIN_NAME="sigyn"
BUNDLE_MACOS_DIR="${INSTALL_DIR}/${APP_BUNDLE}/Contents/MacOS"

REPO_URL="${SIGYN_REPO:-https://github.com/connorguy/sigyn.git}"
REPO_REF="${SIGYN_REF:-main}"
SOURCE_DIR="${SIGYN_SOURCE_DIR:-${HOME}/Library/Caches/sigyn/source}"

# Empty when the script is piped into bash rather than run from a file.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi
BUILD_BUNDLE="${SCRIPT_DIR}/build/tauri-target/release/bundle/macos/${APP_BUNDLE}"

NO_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=true ;;
    -h|--help)
      echo "Usage: ./install.sh [--no-build]"
      echo "       curl -fsSL https://raw.githubusercontent.com/connorguy/sigyn/main/install.sh | bash"
      echo "  --no-build   Skip the build step and install existing artifacts"
      echo ""
      echo "Outside a sigyn checkout, the source is fetched into \$SIGYN_SOURCE_DIR"
      echo "(default ~/Library/Caches/sigyn/source) at \$SIGYN_REF (default main)."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      exit 1
      ;;
  esac
done

# ── helpers ───────────────────────────────────────────────────────────

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$1"; }
fail()  { printf '\033[1;31mERR\033[0m %s\n' "$1" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

# ── preflight checks ─────────────────────────────────────────────────

info "Running preflight checks…"

require_cmd node
require_cmd npm
require_cmd cargo
require_cmd rustc

if [[ "$(uname)" != "Darwin" ]]; then
  fail "This install script only supports macOS."
fi

ok "All prerequisites found"

# ── fetch source (one-line install) ───────────────────────────────────
# Defined as a function and called once it has been read in full, so a
# truncated download cannot run half of it.

is_source_checkout() {
  [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/src-tauri/tauri.conf.json" ]]
}

fetch_source_and_reexec() {
  if [[ "${SIGYN_BOOTSTRAPPED:-}" == "1" ]]; then
    fail "${SOURCE_DIR} does not contain the sigyn source. Remove it and try again."
  fi
  require_cmd git

  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    local origin
    origin="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
    if [[ "$origin" != "$REPO_URL" ]]; then
      fail "${SOURCE_DIR} is a checkout of '${origin:-unknown}', not ${REPO_URL}. Set SIGYN_SOURCE_DIR to another path."
    fi
    info "Updating sigyn source in ${SOURCE_DIR} (${REPO_REF})…"
  elif [[ -e "$SOURCE_DIR" && -n "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ]]; then
    fail "${SOURCE_DIR} already exists and is not a sigyn checkout. Set SIGYN_SOURCE_DIR to another path."
  else
    info "Fetching sigyn source into ${SOURCE_DIR} (${REPO_REF})…"
    mkdir -p "$SOURCE_DIR"
    git -C "$SOURCE_DIR" init -q
    git -C "$SOURCE_DIR" remote add origin "$REPO_URL"
  fi

  git -C "$SOURCE_DIR" fetch -q --depth 1 origin "$REPO_REF"
  # This directory is managed by the installer: tracked files are reset,
  # untracked build caches (node_modules, build/, .cargo-home) are kept.
  git -C "$SOURCE_DIR" checkout -q --force --detach FETCH_HEAD
  ok "Source ready at $(git -C "$SOURCE_DIR" rev-parse --short HEAD)"

  export SIGYN_BOOTSTRAPPED=1
  exec bash "${SOURCE_DIR}/install.sh" "$@"
}

if ! is_source_checkout; then
  fetch_source_and_reexec "$@"
fi

# ── build ─────────────────────────────────────────────────────────────

if [[ "$NO_BUILD" == false ]]; then
  info "Installing npm dependencies…"
  (cd "$SCRIPT_DIR" && npm install --prefer-offline)

  info "Building sigyn (this may take a few minutes on first run)…"
  (
    cd "$SCRIPT_DIR"
    CARGO_HOME="${SCRIPT_DIR}/.cargo-home" \
    CARGO_TARGET_DIR="${SCRIPT_DIR}/build/tauri-target" \
    CI=false \
    npm run tauri:build
  )
  ok "Build complete"
else
  info "Skipping build (--no-build)"
fi

# ── verify build artifacts ────────────────────────────────────────────

if [[ ! -d "$BUILD_BUNDLE" ]]; then
  fail "App bundle not found at ${BUILD_BUNDLE}. Run without --no-build first."
fi

if [[ ! -x "${BUILD_BUNDLE}/Contents/MacOS/${CLI_BIN_NAME}" ]]; then
  fail "CLI binary not found inside app bundle."
fi

ok "Build artifacts verified"

# ── install app bundle ────────────────────────────────────────────────

INSTALLED_APP="${INSTALL_DIR}/${APP_BUNDLE}"

if [[ -d "$INSTALLED_APP" ]]; then
  warn "Existing installation found — upgrading"

  # If the app is running, ask the user to quit it first.
  # Use the exact installed binary path to avoid false positives from
  # build tools or editors whose arguments happen to contain "sigyn.app".
  if pgrep -f "${INSTALLED_APP}/Contents/MacOS/" >/dev/null 2>&1; then
    fail "sigyn appears to be running. Please quit the app before upgrading."
  fi

  info "Removing previous installation…"
  rm -rf "$INSTALLED_APP"
  ok "Previous installation removed"
else
  info "No existing installation found — fresh install"
fi

info "Copying ${APP_BUNDLE} to ${INSTALL_DIR}…"
cp -R "$BUILD_BUNDLE" "$INSTALLED_APP"
ok "App installed to ${INSTALLED_APP}"

# ── symlink CLI binary ────────────────────────────────────────────────

info "Setting up CLI symlink…"

CLI_TARGET="${BUNDLE_MACOS_DIR}/${CLI_BIN_NAME}"
CLI_LINK="${CLI_LINK_DIR}/${CLI_BIN_NAME}"

mkdir -p "$CLI_LINK_DIR"

# Remove stale symlink or warn if a non-symlink file exists
if [[ -L "$CLI_LINK" ]]; then
  rm "$CLI_LINK"
elif [[ -e "$CLI_LINK" ]]; then
  warn "${CLI_LINK} exists and is not a symlink — backing up to ${CLI_LINK}.bak"
  mv "$CLI_LINK" "${CLI_LINK}.bak"
fi

ln -s "$CLI_TARGET" "$CLI_LINK"
ok "CLI available at ${CLI_LINK} → ${CLI_TARGET}"

# ── ensure ~/.local/bin is on PATH ────────────────────────────────────

if echo "$PATH" | tr ':' '\n' | grep -qx "${CLI_LINK_DIR}"; then
  ok "${CLI_LINK_DIR} is already on PATH"
else
  # Detect the user's shell profile
  SHELL_NAME="$(basename "$SHELL")"
  case "$SHELL_NAME" in
    zsh)  PROFILE="${HOME}/.zshrc" ;;
    bash) PROFILE="${HOME}/.bash_profile" ;;
    *)    PROFILE="${HOME}/.profile" ;;
  esac

  PATH_LINE='export PATH="${HOME}/.local/bin:${PATH}"'

  # Only append if not already present in the file
  if [[ -f "$PROFILE" ]] && grep -qF '.local/bin' "$PROFILE"; then
    ok "PATH entry already exists in ${PROFILE}"
  else
    echo "" >> "$PROFILE"
    echo "# Added by sigyn installer" >> "$PROFILE"
    echo "$PATH_LINE" >> "$PROFILE"
    ok "Added ${CLI_LINK_DIR} to PATH in ${PROFILE}"
    warn "Run 'source ${PROFILE}' or open a new terminal for the CLI to be available"
  fi
fi

# ── verify ────────────────────────────────────────────────────────────

info "Verifying installation…"

if [[ -d "$INSTALLED_APP" ]] && [[ -L "$CLI_LINK" ]]; then
  echo ""
  ok "sigyn installed successfully!"
  echo ""
  echo "  App:  ${INSTALLED_APP}"
  echo "  CLI:  ${CLI_LINK}"
  if [[ "${SIGYN_BOOTSTRAPPED:-}" == "1" ]]; then
    echo "  Source: ${SCRIPT_DIR}"
    echo "  Update: re-run the same install command"
  fi
  echo ""
  echo "  First launch: macOS will prompt for keychain access — choose \"Always Allow\""
  echo "  so you are not reprompted on every run."
  echo ""
  echo "  Example CLI usage:"
  echo "    sigyn list"
  echo "    sigyn preview"
  echo "    sigyn uv run python -m your_module"
  echo ""
else
  fail "Installation verification failed."
fi
