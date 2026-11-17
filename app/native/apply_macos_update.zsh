#!/bin/zsh
# Runs outside the application bundle so the bundle can move after shutdown.
set -u
unsetopt HUP

parent_pid="$1"
application="$2"
stage="$3"
updates="$4"
token="$5"
candidate="$stage/MailAI.app"
backup="$stage/previous.app"
receipt="$updates/boot-$token"

process_running() {
  local state
  state=$(/bin/ps -o stat= -p "$1" 2>/dev/null) || return 1
  # A terminated process may retain its PID until its launcher reaps it.
  [[ -n "$state" && "$state" != *Z* ]]
}

record_result() {
  local temporary
  temporary=$(/usr/bin/mktemp "$updates/.install-outcome.XXXXXXXX") || return 1
  print -r -- "$1" > "$temporary" && /bin/mv -f "$temporary" "$updates/install-outcome.txt"
}

reopen_previous() {
  PYINSTALLER_RESET_ENVIRONMENT=1 "$application/Contents/MacOS/MailAI" </dev/null >>"$updates/install-output.log" 2>&1 &!
}

fail_update() {
  record_result failed
  if [[ ! -e "$backup" ]]; then
    if ! process_running "$parent_pid"; then reopen_previous; fi
    /bin/rm -rf "$stage"
  fi
  exit 1
}

restore_update() {
  if [[ -n "${new_pid:-}" ]]; then
    /bin/kill -TERM "$new_pid" 2>/dev/null || true
    for attempt in {1..20}; do
      process_running "$new_pid" || break
      /bin/sleep .5
    done
    /bin/kill -KILL "$new_pid" 2>/dev/null || true
    wait "$new_pid" 2>/dev/null || true
  fi
  /bin/rm -f "$receipt"
  if [[ -d "$backup" ]]; then
    if [[ -e "$application" ]]; then
      /bin/mv "$application" "$stage/failed.app" || fail_update
    fi
    /bin/mv "$backup" "$application" || fail_update
    record_result failed
    reopen_previous
    /bin/rm -rf "$stage"
    exit 1
  fi
  fail_update
}

# Proceed only after the old app has flushed drafts and released its files.
for attempt in {1..120}; do
  process_running "$parent_pid" || break
  /bin/sleep .5
done
if process_running "$parent_pid"; then fail_update; fi

trap restore_update INT TERM
/bin/mv "$application" "$backup" || fail_update
if /bin/mv "$candidate" "$application"; then
  # PyInstaller must start a fresh runtime after the bundle replacement.
  MAILAI_UPDATE_BOOT_TOKEN="$token" PYINSTALLER_RESET_ENVIRONMENT=1 \
    "$application/Contents/MacOS/MailAI" </dev/null >>"$updates/install-output.log" 2>&1 &
  new_pid=$!
  for attempt in {1..120}; do
    [[ -f "$receipt" ]] && break
    process_running "$new_pid" || break
    /bin/sleep .5
  done
  # A page-load receipt alone is insufficient if the new process immediately
  # crashes. Confirm that the application remains alive before committing.
  if [[ -f "$receipt" ]]; then
    /bin/sleep 1
  fi
  if [[ -f "$receipt" ]] && process_running "$new_pid"; then
    trap '' INT TERM
    disown "$new_pid" 2>/dev/null || true
    record_result success
    /bin/rm -f "$receipt"
    /bin/rm -rf "$stage"
    exit 0
  fi
fi

restore_update
