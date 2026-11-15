#!/usr/bin/env bash
# Invoked over SSH by CI; accepts only the commit that passed checks.
set -euo pipefail
umask 077

export VOLTA_HOME=/home/ubuntu/.volta
export PATH="$VOLTA_HOME/bin:$PATH"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'

app_dir=/home/ubuntu/random_fun_bot
service=random-fun-bot
portal_service=random-fun-bot-portal
services=("$service" "$portal_service")
systemctl=/usr/bin/systemctl
target=${1:-}
stage=
stopped=0
completed=0

finish() {
  result=$?
  if (( result != 0 )); then
    echo "Deployment failed; no automatic code or database rollback was attempted." >&2
    if (( stopped )); then
      echo "The services may be stopped or unhealthy. Inspect both before restarting." >&2
    fi
    if [[ -n "$stage" ]]; then
      echo "Recovery files retained at: $stage" >&2
    fi
  elif [[ -n "$stage" && "$completed" == 1 ]]; then
    # stage is created by mktemp under this fixed prefix, outside the checkout.
    case "$stage" in
      /home/ubuntu/random-fun-bot-deploy.*) rm -rf -- "$stage" ;;
      *) echo "Unexpected staging path; leaving it intact." >&2 ;;
    esac
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

[[ "$target" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA.' >&2; exit 1; }
[[ "$(id -un)" == ubuntu ]] || { echo 'Run as ubuntu.' >&2; exit 1; }
cd "$app_dir"

# Also serializes manual invocations on the VPS.
exec 9>/home/ubuntu/.random-fun-bot-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
[[ "$(node --version)" == v22.23.2 ]] || { echo 'Expected Node v22.23.2 (required SQLite APIs); upgrade runtime before deployment.' >&2; exit 1; }
[[ "$(git branch --show-current)" == main ]] || { echo 'Checkout must be on main.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required for portal readiness.' >&2; exit 1; }
for unit in "${services[@]}"; do
  sudo -n -l "$systemctl" stop "$unit" >/dev/null
  sudo -n -l "$systemctl" restart "$unit" >/dev/null
  service_state=$("$systemctl" show "$unit" -p ActiveState --value)
  case "$service_state" in
    active|inactive) ;;
    *) echo "Service state is $service_state for $unit; investigate before deployment." >&2; exit 1 ;;
  esac
done

# Local runtime changes under data/ are allowed, including staged birthdays.
# Other tracked changes need human review before an automated update.
git diff --quiet -- . ':(exclude)data/**' || { echo 'Unstaged code changes block deployment.' >&2; exit 1; }
git diff --cached --quiet -- . ':(exclude)data/**' || { echo 'Staged code changes block deployment.' >&2; exit 1; }
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
if [[ "$(git rev-parse refs/remotes/origin/main)" != "$target" ]]; then
  echo 'A newer main commit exists; skipping this outdated deployment.'
  exit 0
fi
git merge-base --is-ancestor HEAD "$target" || { echo 'Update is not a fast-forward.' >&2; exit 1; }
git diff --quiet HEAD "$target" -- data/ || {
  echo 'Incoming data/ changes require a manual deployment to protect runtime data.' >&2
  exit 1
}

# Install before stopping either service. Failure leaves both running services intact.
stage=$(mktemp -d /home/ubuntu/random-fun-bot-deploy.XXXXXXXX)
git show "$target:package.json" > "$stage/package.json"
git show "$target:package-lock.json" > "$stage/package-lock.json"
npm ci --omit=dev --prefix "$stage" --no-audit --no-fund

# Read-only restart guard before downtime. Never repair or waive blockers here.
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  import { assertCatalogRuntimeRestartReady } from "./lib/catalogRuntimeRecovery.js";
  const db = new DatabaseSync("data/bot.sqlite", { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (db.prepare("PRAGMA user_version").get().user_version === 12) assertCatalogRuntimeRestartReady(db);
  } finally { db.close(); }
'

echo "Deploying $target; previous commit: $(git rev-parse HEAD)"
# Separate commands match the VPS's per-unit sudo permissions.
# Mark before stopping: even a partially failed stop requires operator inspection.
stopped=1
for unit in "${services[@]}"; do
  sudo -n "$systemctl" stop "$unit"
done
git merge --ff-only "$target"
[[ "$(git rev-parse HEAD)" == "$target" ]]
if [[ -e node_modules || -L node_modules ]]; then
  mv node_modules "$stage/previous-node_modules"
fi
mv "$stage/node_modules" node_modules

# Validate with the installed target code before either service can restart.
# Version 12 alone does not distinguish pre-ranking, partial, and final layouts.
if ! node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  import { validateFinalCatalogSchema } from "./lib/catalogFinalSchema.js";
  const db = new DatabaseSync("data/bot.sqlite", { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    validateFinalCatalogSchema(db, { readOnly: true });
  } finally { db.close(); }
'; then
  echo 'Final catalog schema readiness failed. Both services remain stopped.' >&2
  echo 'Inspect the schema and complete the manual ranking cutover with scripts/migrateCharacterRanking.js on a verified offline copy before restarting either service.' >&2
  exit 1
fi

# Linux uptime is monotonic; wall-clock changes must not extend readiness waits.
monotonic_ms() {
  local uptime ignored
  read -r uptime ignored < /proc/uptime || return 1
  [[ "$uptime" =~ ^([0-9]+)\.([0-9]{2})$ ]] || return 1
  printf '%s\n' "$((10#${BASH_REMATCH[1]} * 1000 + 10#${BASH_REMATCH[2]} * 10))"
}
started_at=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
for unit in "${services[@]}"; do
  sudo -n "$systemctl" restart "$unit"
done
readiness_started_ms=$(monotonic_ms)
readiness_deadline_ms=$((readiness_started_ms + 300000))

# Never follow redirects, send credentials, or print response bodies/headers.
# The service accepts the configured loopback Host; public proxy origins remain
# separately configured in the service environment.
portal_ready() {
  local login catalog api
  local -a probe=(--silent --noproxy '*' --connect-timeout 2 --max-time 4
    --output /dev/null)
  login=$(curl "${probe[@]}" --write-out '%{http_code}' http://127.0.0.1:25565/login) || return 1
  [[ "$login" == 200 ]] || return 1
  catalog=$(curl "${probe[@]}" --write-out '%{http_code} %{redirect_url}' http://127.0.0.1:25565/catalog) || return 1
  # portalAuth currently uses 303; also allow the equivalent GET login redirect 302.
  [[ "$catalog" =~ ^30[23]\ https?://127\.0\.0\.1:25565/login$ ]] || return 1
  api=$(curl "${probe[@]}" --write-out '%{http_code}' http://127.0.0.1:25565/api/status) || return 1
  [[ "$api" == 401 ]]
}

# Stable PIDs and restart counters catch startup crash loops in either service.
declare -A pids restarts
for unit in "${services[@]}"; do
  pids[$unit]=$("$systemctl" show "$unit" -p MainPID --value)
  restarts[$unit]=$("$systemctl" show "$unit" -p NRestarts --value)
  [[ "${pids[$unit]}" =~ ^[1-9][0-9]*$ ]]
  [[ "${restarts[$unit]}" =~ ^[0-9]+$ ]]
done
stable_since_ms=$(monotonic_ms)
check_stability() {
  local unit
  for unit in "${services[@]}"; do
    "$systemctl" is-active --quiet "$unit" || return 1
    [[ "$("$systemctl" show "$unit" -p MainPID --value)" == "${pids[$unit]}" ]] || return 1
    [[ "$("$systemctl" show "$unit" -p NRestarts --value)" == "${restarts[$unit]}" ]] || return 1
  done
}
ready=0
portal_is_ready=0
process_stability=stable
readiness_failure() {
  local reason=$1 elapsed_ms game_status='not ready' portal_status='not ready'
  elapsed_ms=$(( $(monotonic_ms) - readiness_started_ms ))
  (( ready )) && game_status=ready
  (( portal_is_ready )) && portal_status=ready
  echo "$reason" >&2
  echo 'Installation and service restarts completed; readiness was not verified within the budget.' >&2
  echo "Installed SHA: $target" >&2
  echo "Elapsed readiness time: $elapsed_ms ms (budget: 300000 ms)" >&2
  echo "Process stability: $process_stability; observed for $(( $(monotonic_ms) - stable_since_ms )) ms (minimum: 30000 ms)" >&2
  echo "Last observations — Discord/game: $game_status; portal HTTP/auth: $portal_status" >&2
  # finish() retains and reports the recovery directory; never undo this install.
  exit 1
}
require_stability() {
  if ! check_stability; then
    process_stability=unstable
    readiness_failure 'Bot or portal process became unhealthy or unstable.'
  fi
}
verified=0
while :; do
  now_ms=$(monotonic_ms)
  remaining_ms=$((readiness_deadline_ms - now_ms))
  (( remaining_ms > 0 )) || break
  # Five-second cadence, clipped to the remaining elapsed-time budget.
  wait_ms=5000
  if (( remaining_ms < wait_ms )); then wait_ms=$remaining_ms; fi
  printf -v poll_delay '%d.%03d' "$((wait_ms / 1000))" "$((wait_ms % 1000))"
  sleep "$poll_delay"
  now_ms=$(monotonic_ms)
  (( now_ms < readiness_deadline_ms )) || break
  require_stability
  # The marker is emitted only after Discord login and durable game recovery.
  if journalctl -b -u "$service" "_PID=${pids[$service]}" --since "$started_at" --no-pager -o cat \
    | grep -Fx 'Character game ready.' > /dev/null; then
    ready=1
  fi
  portal_is_ready=0
  if portal_ready; then portal_is_ready=1; fi
  # Also catch a crash/restart during HTTP requests, not just before them.
  require_stability
  now_ms=$(monotonic_ms)
  # Probe work counts too. Bounded requests may finish just after the deadline;
  # this is not a hard wall-clock bound tighter than subprocess timeouts.
  if (( now_ms <= readiness_deadline_ms && now_ms - stable_since_ms >= 30000 && ready && portal_is_ready )); then
    verified=1
    break
  fi
done
if (( ! verified )); then
  require_stability
  if (( ! ready )); then
    echo 'Discord/game readiness was not observed; check the service journal and deploy-user journal access.' >&2
  fi
  if (( ! portal_is_ready )); then
    echo 'Portal HTTP/auth readiness was not observed; inspect the portal service.' >&2
  fi
  readiness_failure 'Readiness budget expired.'
fi
completed=1
echo "Deployed $target; bot and portal processes stayed stable for at least 30 seconds."
echo 'Discord/game recovery and anonymous portal HTTP/auth readiness were observed.'
