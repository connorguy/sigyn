#!/usr/bin/env bash
set -euo pipefail

# ── sigyn install script ──────────────────────────────────────────────
# Builds the Tauri app and CLI from source, installs sigyn.app into
# /Applications, and symlinks the CLI binary onto PATH.
#
# Usage:
#   ./install.sh            # build + install
#   ./install.sh --no-build # skip build, install from existing artifacts
# ──────────────────────────────────────────────────────────────────────

APP_NAME="sigyn"
APP_BUNDLE="${APP_NAME}.app"
INSTALL_DIR="/Applications"
CLI_LINK_DIR="${HOME}/.local/bin"
CLI_BIN_NAME="sigyn"
BUNDLE_MACOS_DIR="${INSTALL_DIR}/${APP_BUNDLE}/Contents/MacOS"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_BUNDLE="${SCRIPT_DIR}/build/tauri-target/release/bundle/macos/${APP_BUNDLE}"

NO_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=true ;;
    -h|--help)
      echo "Usage: ./install.sh [--no-build]"
      echo "  --no-build   Skip the build step and install existing artifacts"
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
  echo ""
  echo "  First launch: macOS will prompt for keychain access — choose \"Always Allow\""
  echo "  so you are not reprompted on every run."
  echo ""
  echo "  Example CLI usage:"
  echo "    sigyn list"
  echo "    sigyn preview"
  echo "    sigyn run -- uv run python -m your_module"
  echo ""
else
  fail "Installation verification failed."
fi
