#!/usr/bin/env bash
# AutomatedAncestry — one-shot macOS installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-macos.sh)"
#
# Deliberately not `curl ... | bash`: this script shells out
# to `brew install` more than once, and Homebrew's own progress renderer reads
# from stdin -- when this script's own source is arriving on that same stdin
# pipe, brew can silently steal bytes meant for the rest of the script (bash
# reads a piped script incrementally, not all at once), truncating everything
# after that point with no error and a 0 exit code. `bash -c "$(curl ...)"`
# hands the whole script to bash as an already-fully-read string argument
# instead, so it's never competing with anything for stdin. Don't revert this.
#
# Installs git + Node.js 24.16+ if missing, clones the repo, installs Ollama
# with the method this macOS supports, then runs the guided setup (model sized
# for this Mac + OpenClaw). Safe to re-run.
set -euo pipefail

REPO_URL="https://github.com/KurtLehnardt/AutomatedAncestry.git"
TARGET_DIR="${AUTOMATED_ANCESTRY_DIR:-AutomatedAncestry}"
NODE_MAJOR_MIN=24
NODE_MINOR_MIN=16
# Lowest macOS major version Ollama's .app/.dmg (and the Homebrew cask) support.
# Keep in sync with OLLAMA_MIN_MACOS in scripts/setup.mjs.
OLLAMA_MIN_MACOS=14
OLLAMA_TGZ_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
OLLAMA_PREFIX="${AUTOMATED_ANCESTRY_OLLAMA_PREFIX:-$HOME/.local/ollama}"

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

log "AutomatedAncestry — macOS install"

# 0) Confirm we're actually on macOS, and learn the version/arch. Everything
#    below (Homebrew prefix, the Ollama split) keys off these two facts.
[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux use install-linux.sh; on Windows use install-windows.ps1."

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo "")"
MACOS_MAJOR="$(printf '%s' "$MACOS_VERSION" | cut -d. -f1)"
case "$MACOS_MAJOR" in ''|*[!0-9]*) MACOS_MAJOR=0 ;; esac
ARCH="$(uname -m)"
if [ "$MACOS_MAJOR" -gt 0 ]; then
  ok "macOS $MACOS_VERSION ($ARCH)"
else
  warn "couldn't read a macOS version from sw_vers — continuing with generic guidance"
fi

# Homebrew lives at a different prefix per architecture and is NOT on PATH in a
# non-login shell (which is what this one-liner runs as, even when pasted into
# an interactive terminal). Look in both places so
# we don't wrongly conclude brew is missing and send the user down a slower path.
# (Used both here and after a fresh bootstrap below -- kept as one function so
# the two call sites can't drift apart.)
find_and_activate_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      return 0
    fi
  done
  return 1
}

find_and_activate_brew || true
if command -v brew >/dev/null 2>&1; then
  HAVE_BREW=1
  ok "Homebrew found ($(brew --prefix))"
elif [ -t 0 ]; then
  # No Homebrew, but we're attached to a real terminal -- e.g. the documented
  # one-liner (`bash -c "$(curl -fsSL ...)"`) run interactively, which
  # inherits the caller's own stdin rather than a pipe: the git/Node
  # fallbacks below can prompt for a sudo password and actually get an
  # answer, so it's fine to skip Homebrew here if the user would rather not
  # install it.
  HAVE_BREW=0
  warn "Homebrew not found — will use Apple's tools and nodejs.org instead"
else
  # No Homebrew AND no TTY -- a genuinely non-interactive invocation (CI, a
  # cron job, a non-tty SSH session, or the one-liner piped/redirected rather
  # than run interactively). The fallbacks below need sudo to prompt on a
  # real terminal, which none of those have, so without Homebrew this path
  # cannot finish unattended at all. Bootstrap Homebrew instead of dying with
  # a "re-run this by hand"
  # message -- but its own NONINTERACTIVE installer still needs *some* sudo
  # access to create /opt/homebrew (Apple Silicon) or use /usr/local (Intel)
  # on a brand new Mac; it just refuses to prompt for it (`sudo -n`) rather
  # than skipping the requirement entirely. Check that up front so a Mac with
  # no cached/passwordless sudo gets a clear, actionable message instead of
  # Homebrew's own context-free "Insufficient permissions" abort.
  if ! sudo -n true 2>/dev/null; then
    die "Installing Homebrew (needed to finish this without a terminal to prompt on) needs sudo, and this session has no cached sudo credential. Either run 'sudo -v' once in this terminal first and re-run this one-liner within a few minutes, or don't pipe it -- download and run it directly so it has a terminal to prompt through: curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-macos.sh -o install-macos.sh && bash install-macos.sh"
  fi
  log "No Homebrew and no terminal to prompt through — installing Homebrew (needed for an unattended install)..."
  # Fetched into a variable first and checked explicitly: a failure INSIDE a
  # $(...) substitution doesn't trip `set -e` on its own -- it would just
  # silently hand bash an empty string to run as a no-op.
  INSTALL_SCRIPT="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Couldn't download the Homebrew installer -- check your network connection and re-run."
  NONINTERACTIVE=1 /bin/bash -c "$INSTALL_SCRIPT"
  find_and_activate_brew || true
  command -v brew >/dev/null 2>&1 || die "Homebrew install finished but brew isn't on PATH -- open a new terminal and re-run."
  HAVE_BREW=1
  ok "Homebrew installed ($(brew --prefix))"

  # Persist it for the user's NEXT shell too -- otherwise the moment this
  # script exits, a brand new terminal (what the final "next steps" message
  # below assumes) has no brew/git/node on PATH at all, since Homebrew's own
  # installer only offers to do this when it detects an interactive TTY.
  SHELL_PROFILE=""
  case "${SHELL:-}" in
    */zsh) SHELL_PROFILE="$HOME/.zprofile" ;;
    */bash) SHELL_PROFILE="$HOME/.bash_profile" ;;
  esac
  if [ -n "$SHELL_PROFILE" ]; then
    SHELLENV_LINE="eval \"\$($(command -v brew) shellenv)\""
    if [ ! -f "$SHELL_PROFILE" ] || ! grep -qF "$SHELLENV_LINE" "$SHELL_PROFILE"; then
      printf '\n# Added by the AutomatedAncestry installer\n%s\n' "$SHELLENV_LINE" >> "$SHELL_PROFILE"
      ok "added Homebrew to PATH in $SHELL_PROFILE (open a new terminal, or run: source $SHELL_PROFILE)"
    fi
  else
    warn "unrecognized \$SHELL (${SHELL:-<unset>}) -- add 'eval \"\$(brew shellenv)\"' to your shell's profile manually"
  fi
fi

# 1) git. Ships with the Xcode Command Line Tools; `xcode-select --install`
#    opens a GUI installer we can't drive from here, so we trigger it and stop
#    rather than pretending to continue.
if command -v git >/dev/null 2>&1; then
  ok "git already installed ($(git --version))"
elif [ "$HAVE_BREW" -eq 1 ]; then
  log "Installing git via Homebrew..."
  brew install git
  ok "git installed ($(git --version))"
else
  log "Installing the Xcode Command Line Tools (provides git)..."
  xcode-select --install >/dev/null 2>&1 || true
  die "Finish the 'Command Line Tools' install dialog that just opened, then re-run this script."
fi

# 2) Node.js 24.16+ (OpenClaw's floor — granted only needs 22).
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
  if [ "$HAVE_BREW" -eq 1 ]; then
    log "Installing Node.js via Homebrew..."
    brew upgrade node 2>/dev/null || brew install node
  else
    # No Homebrew: use Apple's own installer with the official universal .pkg.
    # This needs sudo, so it only works in an interactive shell — a
    # non-interactive invocation has no TTY to prompt on.
    log "Installing Node.js ${NODE_MAJOR_MIN}+ from nodejs.org..."
    [ -t 0 ] || die "Node.js ${NODE_MAJOR_MIN}+ is required and installing it needs sudo, which can't prompt through a pipe. Install Node from https://nodejs.org (or install Homebrew), then re-run this script."
    PKG_URL="https://nodejs.org/dist/latest-v${NODE_MAJOR_MIN}.x/"  # latest 24.x is always >= 24.16
    # Fetched into a variable first, and the first match taken with `sed -n 1p`
    # rather than `head -1`: under `set -o pipefail`, head closing the pipe
    # early can SIGPIPE the upstream process and abort the whole script.
    PKG_INDEX="$(curl -fsSL "$PKG_URL")" || die "Couldn't reach $PKG_URL — install Node from https://nodejs.org and re-run."
    # nodejs.org lists hrefs as ABSOLUTE paths ("/dist/latest-v24.x/node-v24.16.1.pkg"),
    # so match any leading directory and keep only the basename.
    PKG_NAME="$(printf '%s\n' "$PKG_INDEX" | sed -n 's|.*href="[^"]*/\(node-v[0-9.]*\.pkg\)".*|\1|p' | sed -n '1p')"
    [ -n "$PKG_NAME" ] || die "Couldn't find a Node .pkg at $PKG_URL — install Node from https://nodejs.org and re-run."
    TMP_PKG="$(mktemp -d)/$PKG_NAME"
    curl -fsSL -o "$TMP_PKG" "${PKG_URL}${PKG_NAME}"
    sudo installer -pkg "$TMP_PKG" -target /
    rm -f "$TMP_PKG"
    export PATH="/usr/local/bin:$PATH"
  fi
  command -v node >/dev/null 2>&1 || die "Node still isn't on PATH after installing. Open a new terminal and re-run this script."
  ok "node installed ($(node -v))"
fi

# 3) Clone (skip if already present). Checked via scripts/setup.mjs, not a
# bare .git dir — a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet.
if [ -f "$TARGET_DIR/scripts/setup.mjs" ]; then
  ok "$TARGET_DIR already cloned"
else
  log "Cloning $REPO_URL into ./$TARGET_DIR ..."
  git clone "$REPO_URL" "$TARGET_DIR"
  ok "cloned"
fi

cd "$TARGET_DIR"

# 5) Ollama (only needed for the fully-local path, so never fatal).
#
# This is the one step that genuinely differs on macOS. Ollama's .app/.dmg and
# its Homebrew cask are built for macOS 14+ (OLLAMA_MIN_MACOS); on an older Mac the
# download page hands you an app that won't launch, and Homebrew has dropped
# those releases entirely (no bottles), so `brew install ollama` fails too. The
# release's CLI tarball is a universal binary that DOES run there — it just has
# no .app wrapper, so the daemon must be started by hand and won't survive a
# reboot. We pick the right one instead of letting the user hit the wall.
log "Ollama"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama already installed ($(ollama --version 2>&1 | tail -1))"
elif [ "$MACOS_MAJOR" -gt 0 ] && [ "$MACOS_MAJOR" -lt "$OLLAMA_MIN_MACOS" ]; then
  warn "macOS $MACOS_VERSION is older than Ollama's app requires (${OLLAMA_MIN_MACOS}+) — installing the CLI build instead"
  mkdir -p "$OLLAMA_PREFIX"
  TMP_TGZ="$(mktemp -d)/ollama-darwin.tgz"
  curl -fsSL -o "$TMP_TGZ" "$OLLAMA_TGZ_URL"
  tar xzf "$TMP_TGZ" -C "$OLLAMA_PREFIX"
  rm -f "$TMP_TGZ"
  # Link into whichever bin dir is already writable, so this needs no sudo.
  LINKED=""
  for bindir in /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$bindir" ] && [ -w "$bindir" ]; then
      ln -sf "$OLLAMA_PREFIX/ollama" "$bindir/ollama"
      LINKED="$bindir"
      break
    fi
  done
  if [ -n "$LINKED" ]; then
    ok "ollama installed to $OLLAMA_PREFIX (linked into $LINKED)"
  else
    warn "installed to $OLLAMA_PREFIX but no writable bin dir to link into"
    warn "add it to PATH:  export PATH=\"$OLLAMA_PREFIX:\$PATH\""
  fi
  warn "no .app on this macOS — start the daemon yourself: 'ollama serve' (re-run after each reboot)"
elif [ "$HAVE_BREW" -eq 1 ]; then
  log "Installing Ollama via Homebrew..."
  if brew install ollama; then
    ok "ollama installed ($(ollama --version 2>&1 | tail -1))"
  else
    warn "brew install ollama failed — install it from https://ollama.com/download if you want the local path"
  fi
else
  warn "ollama not installed — get it from https://ollama.com/download if you want the fully local path"
fi

# 5) Hand off to the guided setup (model choice + OpenClaw). On macOS < 14 the
# CLI-tarball Ollama has no .app, so start its daemon for the setup to find.
if [ "$MACOS_MAJOR" -gt 0 ] && [ "$MACOS_MAJOR" -lt "$OLLAMA_MIN_MACOS" ] && command -v ollama >/dev/null 2>&1; then
  (nohup ollama serve >/dev/null 2>&1 &) || true
fi
log "Starting guided setup..."
exec node scripts/setup.mjs "$@"
