#!/usr/bin/env bash
# install-tesis.sh — sync this repo's academia/skills into a project's .pi/skills
# (por defecto: ~/Proyectos/Tesis). Additive/update only: never deletes or
# prunes items this script didn't install.
# Portable: bash 3.2 compatible (macOS default /bin/bash), no associative arrays.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# C1: self-locate via own directory; if academia/skills is missing, fail
# loudly instead of silently syncing nothing.
[ -d "$REPO_ROOT/academia/skills" ] || {
  echo "error: REPO_ROOT ($REPO_ROOT) has no academia/skills/ dir — is this script still inside the repo?" >&2
  exit 1
}

# ---------- defaults / flags ----------
DRY_RUN=0
ASSUME_YES=0
FORCE=0
PROJECT_DIR="${PROJECT:-$HOME/Proyectos/Tesis/.pi/skills}"

usage() {
  cat <<'EOF'
Usage: install-tesis.sh [options]

Options:
  --dry-run           Show the plan, make no changes
  --yes               Skip confirmation prompt
  --force             Replace a foreign symlink pointing outside this repo.
                      WARNING: this deletes the existing foreign symlink first.
  --project=DIR       Target project .pi/skills dir (default: $HOME/Proyectos/Tesis/.pi/skills,
                      or $PROJECT env var)
  -h, --help          Show this help
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --project=*) PROJECT_DIR="${arg#--project=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

# ---------- helpers ----------
info()  { printf '  %s\n' "$*"; }
warn()  { printf '  \033[33m! %s\033[0m\n' "$*" >&2; }
ok()    { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
plan()  { printf '  \033[36m→ %s\033[0m\n' "$*"; }
skip()  { printf '  \033[90m- %s\033[0m\n' "$*"; }

is_tty() { [ -t 0 ] && [ -t 1 ]; }

realpath_portable() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1" 2>/dev/null && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null && return 0
  fi
  perl -MCwd -e 'print Cwd::abs_path(shift), "\n"' "$1" 2>/dev/null
  printf '%s\n' "$1"
}

confirm() {
  local prompt="$1" reply
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if ! is_tty; then
    warn "Non-interactive shell without --yes; refusing to apply. Rerun with --yes or --dry-run."
    return 1
  fi
  read -r -p "$prompt [y/N]: " reply || true
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------- item state classification ----------
# echoes one of: MISSING SYMLINK_OK SYMLINK_FOREIGN OTHER
classify_item() {
  local src="$1" dest="$2"
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    printf 'MISSING\n'; return
  fi
  if [ -L "$dest" ]; then
    local target src_real
    target="$(realpath_portable "$dest")"
    src_real="$(realpath_portable "$src")"
    if [ "$target" = "$src_real" ]; then
      printf 'SYMLINK_OK\n'
    else
      printf 'SYMLINK_FOREIGN\n'
    fi
    return
  fi
  printf 'OTHER\n'
}

# ---------- main ----------
echo "LLMs repo: $REPO_ROOT"
echo "Project:   $PROJECT_DIR"
echo

QUEUE=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -f "${p}/SKILL.md" ] || continue
  item="$(basename "$p")"
  src="$REPO_ROOT/academia/skills/$item"
  dest="$PROJECT_DIR/$item"
  state="$(classify_item "$src" "$dest")"
  case "$state" in
    MISSING)         plan "install  $item" ;;
    SYMLINK_OK)      skip "up to date  $item" ;;
    SYMLINK_FOREIGN) warn "foreign symlink, not ours: $item (use --force to replace)" ;;
    OTHER)           warn "real file/dir at destination, not ours: $item (use --force to replace)" ;;
  esac
  QUEUE="${QUEUE:+$QUEUE|}$state|$item"
done < <(find "$REPO_ROOT/academia/skills" -mindepth 1 -maxdepth 1 -type d | sort)

[ -n "$QUEUE" ] || { echo "No skills found in academia/skills/."; exit 0; }

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run — no changes made)"
  exit 0
fi

ACTIONABLE=0
IFS='|' read -r -a _entries <<<"$QUEUE"
for _e in "${_entries[@]}"; do
  case "$_e" in
    MISSING|SYMLINK_FOREIGN|OTHER)
      [ "$_e" = "MISSING" ] && ACTIONABLE=1
      [ "$_e" = "SYMLINK_FOREIGN" ] && [ "$FORCE" -eq 1 ] && ACTIONABLE=1
      [ "$_e" = "OTHER" ] && [ "$FORCE" -eq 1 ] && ACTIONABLE=1
      ;;
  esac
done

if [ "$ACTIONABLE" -eq 0 ]; then
  echo "Everything already up to date."
  exit 0
fi

if ! confirm "Apply the plan above?"; then
  echo "Aborted."
  exit 0
fi

echo
for _e in "${_entries[@]}"; do
  state="${_e%%|*}"
  item="${_e#*|}"
  src="$REPO_ROOT/academia/skills/$item"
  dest="$PROJECT_DIR/$item"
  case "$state" in
    MISSING)
      mkdir -p "$PROJECT_DIR"
      ln -sfn "$src" "$dest"
      ok "installed $item"
      ;;
    SYMLINK_FOREIGN|OTHER)
      if [ "$FORCE" -eq 1 ]; then
        rm -f "$dest" || rm -rf "$dest"
        mkdir -p "$PROJECT_DIR"
        ln -sfn "$src" "$dest"
        ok "replaced $item"
      else
        skip "left $item untouched"
      fi
      ;;
  esac
done
