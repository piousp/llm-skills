#!/usr/bin/env bash
# Sync this repo's skills/, agents/, scripts/ into installed coding-agent harnesses.
# Additive/update only: never deletes or prunes items this script didn't install.
# Portable: bash 3.2 compatible (macOS default /bin/bash), no associative arrays.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# C1: this script self-locates via its own directory; if it's ever moved
# without this check keeping up, fail loudly instead of silently syncing
# nothing (an empty repo and a wrong root both look like zero items).
[ -d "$REPO_ROOT/skills" ] || {
  echo "error: REPO_ROOT ($REPO_ROOT) has no skills/ dir — is this script still inside the repo?" >&2
  exit 1
}

# ---------- defaults / flags ----------
DRY_RUN=0
ASSUME_YES=0
FORCE=0
MODE=""              # symlink | copy
HARNESS_FILTER=""    # comma list, empty = ask/detect
KINDS="skills,agents,scripts"

usage() {
  cat <<'EOF'
Usage: install-sync.sh [options]

Options:
  --dry-run           Show the plan, make no changes
  --yes               Skip confirmation prompt
  --mode=MODE         symlink | copy  (default: ask, suggests symlink)
  --harness=LIST      Comma list, e.g. --harness=claude,pi (default: ask/detect)
  --kinds=LIST        Comma list of skills,agents,scripts (default: all)
  --force             Replace a real copy with a symlink, or overwrite a
                      foreign symlink pointing outside this repo.
                      WARNING: this deletes the existing real file/dir
                      first, with no backup.
  -h, --help          Show this help
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --mode=*) MODE="${arg#--mode=}" ;;
    --harness=*) HARNESS_FILTER="${arg#--harness=}" ;;
    --kinds=*) KINDS="${arg#--kinds=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

# I4: validate --kinds so a typo fails loudly instead of silently
# producing an empty queue ("Nothing matched").
IFS=',' read -r -a _kind_check <<<"$KINDS"
for _k in "${_kind_check[@]}"; do
  case "$_k" in
    skills|agents|scripts) ;;
    *) echo "Invalid --kinds entry: '$_k' (expected skills, agents, and/or scripts)" >&2; exit 1 ;;
  esac
done
unset _kind_check _k

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
  perl -MCwd -e 'print Cwd::abs_path(shift), "\n"' "$1" 2>/dev/null && return 0
  printf '%s\n' "$1"
}

csv_has() {
  # csv_has "needle" "a,b,c"
  local needle="$1" hay="$2"
  case ",${hay}," in
    *",${needle},"*) return 0 ;;
    *) return 1 ;;
  esac
}

ask() {
  # ask "prompt" "default" -> echoes answer
  local prompt="$1" default="$2" reply
  if ! is_tty; then printf '%s\n' "$default"; return; fi
  read -r -p "$prompt [$default]: " reply || true
  printf '%s\n' "${reply:-$default}"
}

confirm() {
  local prompt="$1" reply
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if ! is_tty; then
    # I1: don't silently auto-approve when there's no one to ask.
    warn "Non-interactive shell without --yes; refusing to apply. Rerun with --yes or --dry-run."
    return 1
  fi
  read -r -p "$prompt [y/N]: " reply || true
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------- harness registry ----------
# One line per harness: name|base_dir|binary|supported_kinds
# (YAGNI: codex has no skills/agents/scripts discovery surface at all, so
# it isn't a row here — add it back if that ever changes.)
harness_records() {
  cat <<EOF
claude|${HOME}/.claude|claude|skills,agents,scripts
pi|${HOME}/.pi/agent|pi|skills,agents,scripts
EOF
}

is_harness_detected() {
  local base="$1" bin="$2"
  [ -d "$base" ] && return 0
  command -v "$bin" >/dev/null 2>&1 && return 0
  return 1
}

# Agent file-layout is a property of (harness, kind), not harness alone:
#   mirror  - dest mirrors the repo's shape 1:1 (flat .md stays flat, dir stays dir)
#   wrapped - every agent normalizes to a directory containing AGENT.md
# (Claude Code on this setup only discovers <agent-name>/AGENT.md; a flat
# .claude/agents/<name>.md file is not picked up. Every other kind, and
# every other harness, mirrors the repo as-is.)
# C2: keying this on harness alone made skills/scripts dedup fail, since
# claude and pi would get different layout tags for the same shared dest.
layout_for() {
  local harness="$1" kind="$2"
  if [ "$kind" = "agents" ] && [ "$harness" = "claude" ]; then
    printf 'wrapped\n'
  else
    printf 'mirror\n'
  fi
}

# item_dest_for <dest_dir> <item> <layout> -> full dest path for one item
item_dest_for() {
  local dest_dir="$1" item="$2" layout="$3"
  if [ "$layout" = "wrapped" ]; then
    case "$item" in
      *.md) printf '%s/%s/AGENT.md\n' "$dest_dir" "${item%.md}"; return ;;
    esac
  fi
  printf '%s/%s\n' "$dest_dir" "$item"
}

# ---------- source enumeration ----------
list_source_items() {
  # list_source_items <kind> -> prints one valid item name per line
  local kind="$1" p base
  case "$kind" in
    skills)
      for p in "$REPO_ROOT"/skills/*/; do
        [ -f "${p}SKILL.md" ] || continue
        basename "$p"
      done
      ;;
    agents)
      for p in "$REPO_ROOT"/agents/*; do
        base="$(basename "$p")"
        case "$base" in .*) continue ;; esac
        if [ -f "$p" ]; then
          case "$base" in *.md) printf '%s\n' "$base" ;; esac
        elif [ -d "$p" ] && [ -f "$p/AGENT.md" ]; then
          printf '%s\n' "$base"
        fi
      done
      ;;
    scripts)
      for p in "$REPO_ROOT"/scripts/*; do
        [ -f "$p" ] || continue
        base="$(basename "$p")"
        case "$base" in .*) continue ;; esac
        printf '%s\n' "$base"
      done
      ;;
  esac
}

# ---------- item state classification ----------
# echoes one of: MISSING SYMLINK_OK SYMLINK_FOREIGN COPY_CURRENT COPY_STALE
classify_item() {
  local src="$1" dest="$2"
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    printf 'MISSING\n'; return
  fi
  if [ -L "$dest" ]; then
    local target
    target="$(realpath_portable "$dest")"
    local src_real
    src_real="$(realpath_portable "$src")"
    if [ "$target" = "$src_real" ]; then
      printf 'SYMLINK_OK\n'
    else
      printf 'SYMLINK_FOREIGN\n'
    fi
    return
  fi
  if diff -rq -x .DS_Store -x .git "$src" "$dest" >/dev/null 2>&1; then
    printf 'COPY_CURRENT\n'
  else
    printf 'COPY_STALE\n'
  fi
}

# ---------- actions ----------
do_symlink() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  ln -sfn "$src" "$dest"
}

do_copy() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -d "$src" ]; then
    mkdir -p "$dest"
    rsync -a --exclude '.DS_Store' --exclude '.git' "$src/" "$dest/"
  else
    cp -f "$src" "$dest"
  fi
}

# I2/I6: --force deletes the existing real file/dir with no backup before
# replacing it (see usage()'s warning). For a wrapped agent (<name>/AGENT.md)
# this also removes the now-empty <name>/ wrapper directory.
remove_dest() {
  local dest="$1"
  if [ -L "$dest" ] || [ -f "$dest" ]; then
    rm -f "$dest"
    if [ "$(basename "$dest")" = "AGENT.md" ]; then
      rmdir "$(dirname "$dest")" 2>/dev/null || true
    fi
  elif [ -d "$dest" ]; then
    rm -rf "$dest"
  fi
}

# ---------- main ----------
echo "LLMs repo: $REPO_ROOT"
echo
echo "Detecting harnesses..."
DETECTED=""
while IFS='|' read -r name base bin kinds; do
  [ -n "$name" ] || continue
  if is_harness_detected "$base" "$bin"; then
    info "$name: detected at $base"
    DETECTED="${DETECTED:+$DETECTED,}${name}"
  fi
done <<EOF
$(harness_records)
EOF

if [ -z "$DETECTED" ]; then
  echo "No supported harnesses detected. Nothing to do."
  exit 0
fi

echo
if [ -z "$HARNESS_FILTER" ]; then
  HARNESS_FILTER="$(ask "Sync which harnesses (comma list)" "$DETECTED")"
fi

if [ -z "$MODE" ]; then
  MODE="$(ask "Install mode: symlink (live updates) or copy (isolated)" "symlink")"
fi
case "$MODE" in
  symlink|copy) ;;
  *) echo "Invalid mode: $MODE (expected symlink|copy)" >&2; exit 1 ;;
esac

echo
echo "Plan (mode=$MODE):"
echo

# Track which (kind,resolved_dest) groups we've already processed, to dedupe
# harnesses that share a destination (e.g. a symlinked ~/.pi/agent/skills).
PROCESSED_GROUPS=""

# Actions queued as: kind|name|src|dest|state|harness_list
declare -a QUEUE=()

while IFS='|' read -r name base bin kinds; do
  [ -n "$name" ] || continue
  csv_has "$name" "$HARNESS_FILTER" || continue

  IFS=',' read -r -a kind_arr <<<"$kinds"
  for kind in "${kind_arr[@]}"; do
    csv_has "$kind" "$KINDS" || continue
    dest_dir="${base}/${kind}"
    resolved_dest_dir="$dest_dir"
    [ -e "$dest_dir" ] && resolved_dest_dir="$(realpath_portable "$dest_dir")"
    layout="$(layout_for "$name" "$kind")"
    group_key="${kind}:${resolved_dest_dir}:${layout}"

    if csv_has "$group_key" "$PROCESSED_GROUPS"; then
      # Already queued under this resolved destination via another harness
      # with the same file layout; just note the extra owner for reporting.
      continue
    fi
    PROCESSED_GROUPS="${PROCESSED_GROUPS:+$PROCESSED_GROUPS,}${group_key}"

    # Find which of the selected harnesses share this resolved destination
    # AND the same agent file layout (mirror vs wrapped never merge).
    owners="$name"
    while IFS='|' read -r n2 b2 bin2 k2; do
      [ -n "$n2" ] || continue
      [ "$n2" = "$name" ] && continue
      csv_has "$n2" "$HARNESS_FILTER" || continue
      csv_has "$kind" "$k2" || continue
      [ "$(layout_for "$n2" "$kind")" = "$layout" ] || continue
      d2="${b2}/${kind}"
      r2="$d2"
      [ -e "$d2" ] && r2="$(realpath_portable "$d2")"
      if [ "$r2" = "$resolved_dest_dir" ]; then
        owners="${owners},${n2}"
      fi
    done <<EOF2
$(harness_records)
EOF2

    layout_note=""
    [ "$kind" = "agents" ] && [ "$layout" = "wrapped" ] && layout_note="  (normalized to <name>/AGENT.md)"
    echo "[$kind] -> $dest_dir  (harness: $owners)${layout_note}"
    while IFS= read -r item; do
      [ -n "$item" ] || continue
      src="$REPO_ROOT/$kind/$item"
      dest="$(item_dest_for "$dest_dir" "$item" "$layout")"
      state="$(classify_item "$src" "$dest")"
      case "$state" in
        MISSING)        plan "install  $item" ;;
        SYMLINK_OK)     skip "up to date (symlink)  $item" ;;
        SYMLINK_FOREIGN) warn "foreign symlink, not ours: $item (use --force to replace)" ;;
        COPY_STALE)     plan "update   $item" ;;
        COPY_CURRENT)   skip "up to date (copy)  $item" ;;
      esac
      QUEUE+=("$kind|$item|$src|$dest|$state|$owners")
    done < <(list_source_items "$kind")
    echo
  done
done <<EOF3
$(harness_records)
EOF3

if [ "${#QUEUE[@]}" -eq 0 ]; then
  echo "Nothing matched the selected harnesses/kinds."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run — no changes made)"
  exit 0
fi

ACTIONABLE=0
for entry in "${QUEUE[@]}"; do
  IFS='|' read -r kind item src dest state owners <<<"$entry"
  case "$state" in
    MISSING|COPY_STALE) ACTIONABLE=1 ;;
    SYMLINK_FOREIGN) [ "$FORCE" -eq 1 ] && ACTIONABLE=1 ;;
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
for entry in "${QUEUE[@]}"; do
  IFS='|' read -r kind item src dest state owners <<<"$entry"
  case "$state" in
    MISSING)
      if [ "$MODE" = "symlink" ]; then do_symlink "$src" "$dest"; else do_copy "$src" "$dest"; fi
      ok "installed $kind/$item -> $dest"
      ;;
    COPY_STALE)
      if [ "$MODE" = "symlink" ]; then
        if [ "$FORCE" -eq 1 ]; then
          remove_dest "$dest"; do_symlink "$src" "$dest"
          ok "converted to symlink $kind/$item"
        else
          do_copy "$src" "$dest"
          ok "updated (copy) $kind/$item — rerun with --force to convert to symlink"
        fi
      else
        do_copy "$src" "$dest"
        ok "updated $kind/$item"
      fi
      ;;
    SYMLINK_FOREIGN)
      if [ "$FORCE" -eq 1 ]; then
        remove_dest "$dest"
        if [ "$MODE" = "symlink" ]; then do_symlink "$src" "$dest"; else do_copy "$src" "$dest"; fi
        ok "replaced foreign symlink $kind/$item"
      else
        skip "left foreign symlink untouched: $kind/$item"
        continue
      fi
      ;;
    *)
      continue
      ;;
  esac
done
