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
      echo "The service may be stopped or unhealthy. Inspect it before restarting." >&2
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
sudo -n -l "$systemctl" stop "$service" >/dev/null
sudo -n -l "$systemctl" restart "$service" >/dev/null
service_state=$("$systemctl" show "$service" -p ActiveState --value)
case "$service_state" in
  active|inactive) ;;
  *) echo "Service state is $service_state; investigate before deployment." >&2; exit 1 ;;
esac

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

# Install before stopping the service. Failure here leaves the running bot intact.
stage=$(mktemp -d /home/ubuntu/random-fun-bot-deploy.XXXXXXXX)
git show "$target:package.json" > "$stage/package.json"
git show "$target:package-lock.json" > "$stage/package-lock.json"
npm ci --omit=dev --prefix "$stage" --no-audit --no-fund

echo "Deploying $target; previous commit: $(git rev-parse HEAD)"
sudo -n "$systemctl" stop "$service"
stopped=1
git merge --ff-only "$target"
[[ "$(git rev-parse HEAD)" == "$target" ]]
if [[ -e node_modules || -L node_modules ]]; then
  mv node_modules "$stage/previous-node_modules"
fi
mv "$stage/node_modules" node_modules
started_at=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
sudo -n "$systemctl" restart "$service"

# A stable PID and restart counter catch common startup crash loops.
pid=$("$systemctl" show "$service" -p MainPID --value)
restarts=$("$systemctl" show "$service" -p NRestarts --value)
[[ "$pid" =~ ^[1-9][0-9]*$ ]]
ready=0
for attempt in {1..12}; do
  sleep 5
  "$systemctl" is-active --quiet "$service"
  [[ "$("$systemctl" show "$service" -p MainPID --value)" == "$pid" ]]
  [[ "$("$systemctl" show "$service" -p NRestarts --value)" == "$restarts" ]]
  # The marker is emitted only after Discord login and durable game recovery.
  if journalctl -b -u "$service" "_PID=$pid" --since "$started_at" --no-pager -o cat \
    | grep -Fx 'Character game ready.' > /dev/null; then
    ready=1
  fi
  if (( attempt >= 6 && ready )); then break; fi
done
(( ready )) || { echo 'Discord/game readiness was not observed; check the service journal and deploy-user journal access.' >&2; exit 1; }
completed=1
echo "Deployed $target; service process stayed stable for 30 seconds."
echo 'Discord login and game recovery readiness were observed for the started process.'
