#!/usr/bin/env bash
# AutomatedAncestry — one-shot Linux installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-linux.sh)"
#
# Deliberately not `curl ... | bash`: this script shells out to the system
# package manager (apt/dnf/yum), which can read from stdin during its own
# install -- when this script's own source is arriving on that same stdin
# pipe, the package manager can silently steal bytes meant for the rest of
# the script (bash reads a piped script incrementally, not all at once),
# truncating everything after that point with no error and a 0 exit code.
# `bash -c "$(curl ...)"` hands the whole script to bash as an already-fully-
# read string argument instead, so it's never competing with anything for
# stdin. Don't revert this.
#
# Installs git + Node.js 24.16+ if missing (apt/dnf/yum — including a
# Chromebook's Linux container), clones the repo, then runs the guided setup:
# Ollama, a model sized for this machine, and OpenClaw. Safe to re-run.
set -euo pipefail

REPO_URL="https://github.com/KurtLehnardt/AutomatedAncestry.git"
TARGET_DIR="${AUTOMATED_ANCESTRY_DIR:-AutomatedAncestry}"
NODE_MAJOR_MIN=24
NODE_MINOR_MIN=16

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

log "AutomatedAncestry — Linux install"

# 1) Package manager.
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
else
  die "No supported package manager found (need apt-get, dnf, or yum). Install Node.js ${NODE_MAJOR_MIN}+ and git manually — see the README's Linux section."
fi
ok "Detected package manager: $PM"

SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "Need root or sudo to install packages."
  fi
fi

# Runs "$@" as root, preserving the environment (-E) — but only passes -E when
# actually invoking sudo. `$SUDO -E "$@"` breaks when SUDO is empty (already
# root): the bare "-E" is left as the first word and bash tries to execute a
# program named "-E".
as_root() {
  if [ -n "$SUDO" ]; then sudo -E "$@"; else "$@"; fi
}

# 2) git.
if command -v git >/dev/null 2>&1; then
  ok "git already installed ($(git --version))"
else
  log "Installing git..."
  case "$PM" in
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y git ;;
    dnf) $SUDO dnf install -y git ;;
    yum) $SUDO yum install -y git ;;
  esac
  ok "git installed ($(git --version))"
fi

# 3) Node.js 24.16+ (OpenClaw's floor — granted only needs 22).
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  v="$(node -v | sed 's/^v//')"; maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"
  case "$maj$min" in ''|*[!0-9]*) return 1 ;; esac
  [ "$maj" -gt "$NODE_MAJOR_MIN" ] || { [ "$maj" -eq "$NODE_MAJOR_MIN" ] && [ "$min" -ge "$NODE_MINOR_MIN" ]; }
}
NODE_OK=0
if node_ok; then
  ok "node already installed ($(node -v))"
  NODE_OK=1
elif command -v node >/dev/null 2>&1; then
  warn "node $(node -v) is older than ${NODE_MAJOR_MIN}.${NODE_MINOR_MIN} — installing a newer one"
fi
if [ "$NODE_OK" -ne 1 ]; then
  log "Installing Node.js ${NODE_MAJOR_MIN}..."
  case "$PM" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
      $SUDO apt-get install -y nodejs
      ;;
    dnf)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
      $SUDO dnf install -y nodejs
      ;;
    yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
      $SUDO yum install -y nodejs
      ;;
  esac
  ok "node installed ($(node -v))"
fi

# 4) Clone (skip if already present). Checked via scripts/setup.mjs, not a
# bare .git dir — a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet. If $TARGET_DIR exists but isn't a finished clone,
# `git clone` below fails with its own clear "already exists" error rather
# than this script guessing whether it's safe to delete.
if [ -f "$TARGET_DIR/scripts/setup.mjs" ]; then
  ok "$TARGET_DIR already cloned"
else
  log "Cloning $REPO_URL into ./$TARGET_DIR ..."
  git clone "$REPO_URL" "$TARGET_DIR"
  ok "cloned"
fi

# 5) Hand off to the guided setup (Ollama + model + OpenClaw). It refuses to
# run as root, and needs a terminal for its questions — this script is run as
# `bash -c "$(curl ...)"`, so stdin is still the user's terminal.
cd "$TARGET_DIR"
log "Starting guided setup..."
exec node scripts/setup.mjs "$@"
