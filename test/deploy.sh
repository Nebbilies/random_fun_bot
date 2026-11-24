#!/usr/bin/env bash
# Offline integration checks: real Git repositories, mocked VPS/service tools.
set -euo pipefail
source_script=$(cd "$(dirname "$0")/.." && pwd)/scripts/deploy.sh
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mocks="$root/bin"
mkdir -p "$mocks"

cat > "$mocks/id" <<'EOF'
#!/usr/bin/env bash
echo ubuntu
EOF
cat > "$mocks/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == --version ]]; then echo v22.23.2; exit 0; fi
if [[ "$*" == *'validateCatalogForDeployment'* ]]; then
  [[ "$PWD" == "$FAKE_APP" ]]
  [[ "$(git rev-parse HEAD)" == "$FAKE_TARGET" ]]
  [[ "$(cat node_modules/version)" == new ]]
  [[ -f "${FAKE_LOG}.stopped.random-fun-bot" && -f "${FAKE_LOG}.stopped.random-fun-bot-portal" ]]
  ! grep -q '^systemctl restart ' "$FAKE_LOG"
  [[ "$*" == *'./lib/catalogDb.js'* ]]
  [[ "$*" == *'validateCatalogForDeployment("data/bot.sqlite")'* ]]
  if [[ "$FAKE_CATALOG_LAYOUT" == pre-main-franchise ]]; then
    echo 'main franchise schema upgrade' >> "$FAKE_LOG"
    if [[ "${FAKE_SCHEMA_UPGRADE_FAIL:-0}" == 1 ]]; then
      echo 'Main franchise schema upgrade failed' >&2
      exit 1
    fi
  fi
  echo 'final catalog schema readiness' >> "$FAKE_LOG"
  case "$FAKE_CATALOG_LAYOUT" in
    final|pre-main-franchise) exit 0 ;;
    pre-ranking) echo 'Character ranking migration required' >&2 ;;
    partial|unknown) echo 'Invalid final catalog schema' >&2 ;;
    *) exit 2 ;;
  esac
  exit 1
fi
[[ "$*" == *'assertCatalogRuntimeRestartReady'* ]]
echo 'runtime restart preflight' >> "$FAKE_LOG"
exit "${FAKE_RUNTIME_BLOCKED:-0}"
EOF
cat > "$mocks/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -n ]] && shift
if [[ "$1" == -l ]]; then
  shift
  echo "permission ${*:2}" >> "$FAKE_LOG"
  [[ "${*:2}" != "${FAKE_DENY:-none}" ]]
  exit $?
fi
exec "$@"
EOF
cat > "$mocks/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
unit=$2
case "$unit" in
  random-fun-bot) state=$FAKE_SERVICE_STATE; pid=123 ;;
  random-fun-bot-portal) state=$FAKE_PORTAL_STATE; pid=456 ;;
  --quiet) unit=$3 ;;
  *) exit 2 ;;
esac
case "$1" in
  stop)
    [[ "${FAKE_STOP_FAIL:-none}" != "$unit" ]] || exit 18
    touch "${FAKE_LOG}.stopped.$unit" ;;
  restart)
    [[ "${FAKE_RESTART_FAIL:-none}" != "$unit" ]] || exit 19
    [[ -f "${FAKE_LOG}.stopped.random-fun-bot" && -f "${FAKE_LOG}.stopped.random-fun-bot-portal" ]] || exit 2
    [[ "$(cat "$FAKE_APP/node_modules/version")" == new ]] || exit 2
    touch "${FAKE_LOG}.started.$unit" ;;
  is-active)
    [[ -f "${FAKE_LOG}.started.$unit" ]] || exit 3
    [[ "${FAKE_CRASH:-}" != "$unit" ]] || exit 3 ;;
  show)
    case "$4" in
      ActiveState) echo "$state" ;;
      MainPID|NRestarts)
        count_file="${FAKE_LOG}.$unit.$4"
        count=0
        [[ ! -f "$count_file" ]] || read -r count < "$count_file"
        echo $((count + 1)) > "$count_file"
        if [[ "$4" == MainPID ]]; then
          [[ "${FAKE_PID_CHANGE:-}" != "$unit" || "$count" == 0 ]] || pid=999
          echo "$pid"
        else
          if [[ "${FAKE_RESTART_CHANGE:-}" == "$unit" && "$count" != 0 ]]; then echo 1; else echo 0; fi
        fi ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
EOF
cat > "$mocks/journalctl" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *' _PID=123 '* && " $* " == *' --since '* ]] || exit 2
read -r now < "$FAKE_CLOCK"
if [[ "${FAKE_DISCORD_READY:-1}" == 1 ]] && (( now >= FAKE_READY_AT_MS )); then
  echo 'Character game ready.'
fi
exit 0
EOF
cat > "$mocks/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo install >> "$FAKE_LOG"
! grep -Eq '^systemctl (stop|restart) ' "$FAKE_LOG" || exit 2
[[ "${FAKE_NPM_FAIL:-0}" == 0 ]] || exit 17
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --prefix ]]; then
    mkdir -p "$2/node_modules"
    echo new > "$2/node_modules/version"
    exit 0
  fi
  shift
done
exit 1
EOF
cat > "$mocks/flock" <<'EOF'
#!/usr/bin/env bash
exit "${FAKE_LOCK_FAIL:-0}"
EOF
cat > "$mocks/sleep" <<'EOF'
#!/usr/bin/env bash
read -r now < "$FAKE_CLOCK"
seconds=${1%%.*}
fraction=${1#*.}
[[ "$1" == *.* ]] || fraction=0
fraction="${fraction}000"
printf '%s\n' "$((now + seconds * 1000 + 10#${fraction:0:3}))" > "$FAKE_CLOCK"
EOF
cat > "$mocks/fake_monotonic_ms" <<'EOF'
#!/usr/bin/env bash
read -r now < "$FAKE_CLOCK"
printf '%s\n' "$now"
EOF
cat > "$mocks/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$FAKE_LOG"
read -r now < "$FAKE_CLOCK"
printf '%s\n' "$((now + FAKE_PROBE_COST_MS))" > "$FAKE_CLOCK"
[[ " $* " == *' --connect-timeout 2 '* && " $* " == *' --max-time 4 '* ]]
[[ " $* " == *' --noproxy * '* && " $* " == *' --output /dev/null '* ]]
# The deployed host guard is configured with --public-host=127.0.0.1.
[[ " $* " != *' --header Host: nebby.satancraft.net '* ]]
[[ " $* " != *' --location '* && " $* " != *' --cookie '* ]]
[[ -f "${FAKE_LOG}.started.random-fun-bot-portal" ]]
case "${*: -1}" in
  http://127.0.0.1:25565/login) endpoint=login; reply=200 ;;
  http://127.0.0.1:25565/catalog) endpoint=catalog; reply="${FAKE_REDIRECT:-303} http://127.0.0.1:25565/login" ;;
  http://127.0.0.1:25565/api/status) endpoint=api; reply=401 ;;
  *) exit 2 ;;
esac
[[ "${FAKE_HTTP_FAIL:-}" != timeout ]] || exit 28
if [[ "${FAKE_HTTP_FAIL:-}" == "$endpoint" ]]; then reply=500; fi
if [[ "${FAKE_HTTP_FAIL:-}" == wrong-redirect && "$endpoint" == catalog ]]; then reply='303 https://example.test/login'; fi
if [[ "${FAKE_HTTP_CRASH:-0}" == 1 ]]; then export FAKE_CRASH=random-fun-bot-portal; rm -f "${FAKE_LOG}.started.random-fun-bot-portal"; fi
printf '%s' "$reply"
EOF
# Observe the real Git/mv boundary while still using real fixture repositories.
export REAL_GIT=$(command -v git) REAL_MV=$(command -v mv)
cat > "$mocks/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == merge ]]; then
  echo merge >> "$FAKE_LOG"
  [[ -f "${FAKE_LOG}.stopped.random-fun-bot" && -f "${FAKE_LOG}.stopped.random-fun-bot-portal" ]] || exit 2
  [[ "${FAKE_MERGE_FAIL:-0}" == 0 ]] || exit 20
fi
exec "$REAL_GIT" "$@"
EOF
cat > "$mocks/mv" <<'EOF'
#!/usr/bin/env bash
echo swap >> "$FAKE_LOG"
[[ -f "${FAKE_LOG}.stopped.random-fun-bot" && -f "${FAKE_LOG}.stopped.random-fun-bot-portal" ]] || exit 2
exec "$REAL_MV" "$@"
EOF
chmod +x "$mocks/"*
export PATH="$mocks:$PATH"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Fixture GIT_COMMITTER_NAME=Fixture
export GIT_AUTHOR_EMAIL=fixture@example.test GIT_COMMITTER_EMAIL=fixture@example.test

setup_case() {
  home="$root/$1/ubuntu"
  mkdir -p "$home"
  git init --bare --initial-branch=main "$home/origin.git" >/dev/null
  git clone -q "$home/origin.git" "$home/seed" 2>/dev/null
  mkdir -p "$home/seed/data"
  printf '{}\n' > "$home/seed/package.json"
  printf '{}\n' > "$home/seed/package-lock.json"
  echo base > "$home/seed/app.js"
  echo glossary > "$home/seed/GLOSSARY.md"
  echo seed > "$home/seed/data/birthdays.json"
  git -C "$home/seed" add .
  git -C "$home/seed" commit -qm base
  git -C "$home/seed" push -q origin main
  git clone -q "$home/origin.git" "$home/random_fun_bot"
  app="$home/random_fun_bot"
  previous=$(git -C "$app" rev-parse HEAD)
  mkdir -p "$app/node_modules"
  echo old > "$app/node_modules/version"
  echo production-birthdays > "$app/data/birthdays.json"
  git -C "$app" add data/birthdays.json
  echo production-debt > "$app/data/debt.txt"
  echo production-database > "$app/data/bot.sqlite"
  echo updated > "$home/seed/app.js"
  git -C "$home/seed" add app.js
  git -C "$home/seed" commit -qm update
  git -C "$home/seed" push -q origin main
  target=$(git -C "$home/seed" rev-parse HEAD)
  export FAKE_TARGET="$target" FAKE_CATALOG_LAYOUT=final FAKE_RUNTIME_BLOCKED=0 FAKE_SCHEMA_UPGRADE_FAIL=0
  export FAKE_STOP_FAIL=none FAKE_RESTART_FAIL=none FAKE_MERGE_FAIL=0
  sed -e "s|/home/ubuntu|$home|g" \
      -e "s|systemctl=/usr/bin/systemctl|systemctl=$mocks/systemctl|" \
      -e '/^monotonic_ms() {$/,/^}$/c\monotonic_ms() { fake_monotonic_ms; }' \
      "$source_script" > "$home/deploy.sh"
  export FAKE_LOG="$home/service.log" FAKE_APP="$app" FAKE_NPM_FAIL=0 FAKE_LOCK_FAIL=0 FAKE_SERVICE_STATE=active FAKE_DISCORD_READY=1
  export FAKE_PORTAL_STATE=active FAKE_DENY=none FAKE_CRASH=none FAKE_PID_CHANGE=none FAKE_RESTART_CHANGE=none FAKE_HTTP_FAIL=none FAKE_HTTP_CRASH=0 FAKE_REDIRECT=303
  export FAKE_CLOCK="$home/clock" FAKE_READY_AT_MS=0 FAKE_PROBE_COST_MS=0
  printf '0\n' > "$FAKE_CLOCK"
  : > "$FAKE_LOG"
}

assert_data() {
  [[ "$(cat "$app/data/birthdays.json")" == production-birthdays ]]
  [[ "$(git -C "$app" show :data/birthdays.json)" == production-birthdays ]]
  [[ "$(cat "$app/data/debt.txt")" == production-debt ]]
  [[ "$(cat "$app/data/bot.sqlite")" == production-database ]]
}

assert_untouched() {
  [[ "$(git -C "$app" rev-parse HEAD)" == "$previous" ]]
  [[ "$(cat "$app/node_modules/version")" == old ]]
  ! grep -Eq '^systemctl (stop|restart) ' "$FAKE_LOG"
  assert_data
}

for layout in pre-ranking partial unknown; do
  setup_case "catalog-$layout"
  export FAKE_CATALOG_LAYOUT=$layout
  if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then
    echo "FAIL: $layout catalog passed deployment" >&2
    exit 1
  fi
  [[ -f "${FAKE_LOG}.stopped.random-fun-bot" && -f "${FAKE_LOG}.stopped.random-fun-bot-portal" ]]
  ! grep -q '^systemctl restart ' "$FAKE_LOG"
  ! grep -q '^curl ' "$FAKE_LOG"
  grep -q '^final catalog schema readiness$' "$FAKE_LOG"
  grep -Fq 'Both services remain stopped.' "$home/output"
  grep -Fq 'manual ranking cutover' "$home/output"
  grep -Fq 'scripts/migrateCharacterRanking.js' "$home/output"
  grep -Fq 'no automatic code or database rollback' "$home/output"
  [[ "$(git -C "$app" rev-parse HEAD)" == "$target" ]]
  [[ "$(cat "$app/node_modules/version")" == new ]]
  recovery=("$home"/random-fun-bot-deploy.*/previous-node_modules)
  [[ "$(cat "${recovery[0]}/version")" == old ]]
  grep -Fq "Recovery files retained at: ${recovery[0]%/previous-node_modules}" "$home/output"
  assert_data
done
echo 'PASS: pre-ranking, partial and unknown catalogs leave both services stopped for manual ranking cutover'

setup_case main-franchise-upgrade
export FAKE_CATALOG_LAYOUT=pre-main-franchise
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
expected=$(printf '%s\n' 'main franchise schema upgrade' 'final catalog schema readiness' \
  'systemctl restart random-fun-bot' 'systemctl restart random-fun-bot-portal')
[[ "$(grep -E '^(main franchise schema upgrade|final catalog schema readiness|systemctl restart )' "$FAKE_LOG")" == "$expected" ]]
assert_data

setup_case main-franchise-upgrade-failure
export FAKE_CATALOG_LAYOUT=pre-main-franchise FAKE_SCHEMA_UPGRADE_FAIL=1
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then
  echo 'FAIL: unsuccessful main-franchise migration passed deployment' >&2
  exit 1
fi
grep -q '^main franchise schema upgrade$' "$FAKE_LOG"
! grep -Eq '^(final catalog schema readiness|systemctl restart )' "$FAKE_LOG"
grep -Fq 'Both services remain stopped.' "$home/output"
assert_data
echo 'PASS: main-franchise upgrade precedes validation and restart; upgrade failure blocks both'

setup_case preserve-data
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
[[ "$(git -C "$app" rev-parse HEAD)" == "$target" ]]
[[ "$(cat "$app/node_modules/version")" == new ]]
grep -q '^systemctl restart random-fun-bot$' "$FAKE_LOG"
grep -q '^systemctl restart random-fun-bot-portal$' "$FAKE_LOG"
# Both units' permissions and states must be checked before installation/stops.
expected=$(printf '%s\n' \
  'permission stop random-fun-bot' 'permission restart random-fun-bot' \
  'systemctl show random-fun-bot -p ActiveState --value' \
  'permission stop random-fun-bot-portal' 'permission restart random-fun-bot-portal' \
  'systemctl show random-fun-bot-portal -p ActiveState --value' \
  install 'runtime restart preflight' 'systemctl stop random-fun-bot' 'systemctl stop random-fun-bot-portal' \
  merge swap swap 'final catalog schema readiness' 'systemctl restart random-fun-bot' 'systemctl restart random-fun-bot-portal')
[[ "$(head -n 16 "$FAKE_LOG")" == "$expected" ]]
[[ "$(grep -c '^systemctl is-active --quiet random-fun-bot-portal$' "$FAKE_LOG")" -ge 12 ]]
assert_data
echo 'PASS: both services preflight/install/stop/swap/restart in order; runtime data preserved'

setup_case delayed-readiness
export FAKE_READY_AT_MS=152000
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
read -r elapsed < "$FAKE_CLOCK"
(( elapsed >= 152000 && elapsed <= 300000 ))
assert_data
echo 'PASS: real game readiness at 152 seconds succeeds within the elapsed budget'

# Timeout diagnostics must describe the installed release, not a skipped install.
assert_readiness_timeout() {
  grep -Fq "Installed SHA: $target" "$home/output"
  grep -Fq 'Installation and service restarts completed; readiness was not verified' "$home/output"
  grep -Fq 'Process stability: stable' "$home/output"
  grep -Fq 'no automatic code or database rollback' "$home/output"
  [[ "$(git -C "$app" rev-parse HEAD)" == "$target" ]]
  [[ "$(cat "$app/node_modules/version")" == new ]]
  recovery=("$home"/random-fun-bot-deploy.*/previous-node_modules)
  [[ -d "${recovery[0]}" ]]
  grep -Fq "Recovery files retained at: ${recovery[0]%/previous-node_modules}" "$home/output"
  assert_data
}

setup_case over-budget-readiness
export FAKE_READY_AT_MS=301000
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
assert_readiness_timeout
[[ "$(< "$FAKE_CLOCK")" == 300000 ]]
grep -Fq 'Elapsed readiness time: 300000 ms (budget: 300000 ms)' "$home/output"
grep -Fq 'Discord/game: not ready; portal HTTP/auth: ready' "$home/output"
echo 'PASS: readiness beyond 300 seconds fails with installed SHA, elapsed/stability/readiness and retained paths'

setup_case probe-cost
export FAKE_READY_AT_MS=291000 FAKE_PROBE_COST_MS=4000
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
assert_readiness_timeout
[[ "$(< "$FAKE_CLOCK")" == 306000 ]]
grep -Fq 'Elapsed readiness time: 306000 ms (budget: 300000 ms)' "$home/output"
grep -Fq 'Discord/game: ready; portal HTTP/auth: ready' "$home/output"
echo 'PASS: probe cost counts; readiness whose probes finish over budget fails, with bounded-command overshoot reported'

setup_case probe-cost-stability
export FAKE_PROBE_COST_MS=4000
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
[[ "$(< "$FAKE_CLOCK")" == 34000 ]]
assert_data
echo 'PASS: minimum stability is 30 elapsed seconds including probe work, not six attempts'

setup_case incoming-data
echo incoming > "$home/seed/data/birthdays.json"
git -C "$home/seed" add data/birthdays.json
git -C "$home/seed" commit -qm data-change
git -C "$home/seed" push -q origin main
target=$(git -C "$home/seed" rev-parse HEAD)
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
grep -q 'Incoming data/ changes' "$home/output"
assert_untouched
echo 'PASS: incoming runtime-data changes rejected before stopping service'

setup_case install-failure
export FAKE_NPM_FAIL=1
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
assert_untouched
echo 'PASS: dependency installation failure leaves old code and service untouched'

setup_case stale-commit
bash "$home/deploy.sh" "$previous" > "$home/output" 2>&1
grep -q 'skipping this outdated deployment' "$home/output"
assert_untouched
echo 'PASS: stale queued deployment is skipped'

setup_case runtime-blocked
export FAKE_RUNTIME_BLOCKED=1
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
assert_untouched
export FAKE_RUNTIME_BLOCKED=0
echo 'PASS: runtime restart blockers are rejected before either service stops'

for unit in random-fun-bot random-fun-bot-portal; do
  setup_case "stop-failure-$unit"
  export FAKE_STOP_FAIL=$unit
  if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
  [[ "$(git -C "$app" rev-parse HEAD)" == "$previous" ]]
  [[ "$(cat "$app/node_modules/version")" == old ]]
  ! grep -Eq '^(merge|swap|final catalog schema readiness|systemctl restart )' "$FAKE_LOG"
  assert_data

  setup_case "restart-failure-$unit"
  export FAKE_RESTART_FAIL=$unit
  if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
  grep -q '^final catalog schema readiness$' "$FAKE_LOG"
  [[ ! -f "${FAKE_LOG}.started.$unit" ]]
  [[ "$(grep -c '^systemctl restart ' "$FAKE_LOG")" == "$([[ "$unit" == random-fun-bot ]] && echo 1 || echo 2)" ]]
  [[ "$(git -C "$app" rev-parse HEAD)" == "$target" ]]
  [[ "$(cat "$app/node_modules/version")" == new ]]
  grep -Fq 'Recovery files retained at:' "$home/output"
  assert_data
done
setup_case update-failure
export FAKE_MERGE_FAIL=1
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
[[ -f "${FAKE_LOG}.stopped.random-fun-bot" && -f "${FAKE_LOG}.stopped.random-fun-bot-portal" ]]
[[ "$(git -C "$app" rev-parse HEAD)" == "$previous" ]]
[[ "$(cat "$app/node_modules/version")" == old ]]
! grep -Eq '^(swap|final catalog schema readiness|systemctl restart )' "$FAKE_LOG"
assert_data
echo 'PASS: stop, update and restart failures never bypass readiness or trigger recovery restarts'

setup_case dirty-code
echo manual-change >> "$app/app.js"
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
grep -q 'Unstaged code changes' "$home/output"
assert_untouched
echo 'PASS: local code edits block deployment without disturbing production'

setup_case locked
export FAKE_LOCK_FAIL=1
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
grep -q 'Another deployment is running' "$home/output"
assert_untouched
echo 'PASS: held deployment lock rejects a competing invocation'

setup_case stopped-service
export FAKE_SERVICE_STATE=inactive
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
[[ "$(git -C "$app" rev-parse HEAD)" == "$target" ]]
grep -q '^systemctl restart random-fun-bot$' "$FAKE_LOG"
assert_data
echo 'PASS: deployment starts a deliberately stopped service'

setup_case missing-readiness
export FAKE_DISCORD_READY=0
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
grep -q 'Discord/game readiness was not observed' "$home/output"
assert_readiness_timeout
[[ "$(< "$FAKE_CLOCK")" == 300000 ]]
echo 'PASS: a live process without Discord/game readiness cannot pass deployment'

setup_case failed-service
export FAKE_SERVICE_STATE=failed
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
grep -q 'Service state is failed' "$home/output"
assert_untouched
echo 'PASS: an unexpectedly failed service requires investigation before deployment'

for unit in random-fun-bot random-fun-bot-portal; do
  for action in stop restart; do
    setup_case "denied-$unit-$action"
    export FAKE_DENY="$action $unit"
    if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
    assert_untouched
    ! grep -q '^install$' "$FAKE_LOG"
  done
  for state in activating deactivating failed unknown; do
    setup_case "state-$unit-$state"
    if [[ "$unit" == random-fun-bot ]]; then export FAKE_SERVICE_STATE=$state; else export FAKE_PORTAL_STATE=$state; fi
    if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
    assert_untouched
  done
  setup_case "inactive-$unit"
  if [[ "$unit" == random-fun-bot ]]; then export FAKE_SERVICE_STATE=inactive; else export FAKE_PORTAL_STATE=inactive; fi
  bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
  assert_data
  for failure in CRASH PID_CHANGE RESTART_CHANGE; do
    setup_case "unstable-$unit-$failure"
    export "FAKE_$failure=$unit"
    if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
    grep -q 'unhealthy or unstable' "$home/output"
    assert_data
    recovery=("$home"/random-fun-bot-deploy.*/previous-node_modules)
    [[ -d "${recovery[0]}" ]]
  done
done
echo 'PASS: both services require permissions and safe initial states; crashes/PID/restart changes fail deployment'

for failure in login catalog api timeout wrong-redirect; do
  setup_case "http-$failure"
  export FAKE_HTTP_FAIL=$failure
  if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
  grep -q 'Portal HTTP/auth readiness was not observed' "$home/output"
  assert_data
done
setup_case http-crash
export FAKE_HTTP_CRASH=1
if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
grep -q 'unhealthy or unstable' "$home/output"
assert_data
setup_case redirect-302
export FAKE_REDIRECT=302
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
assert_data
echo 'PASS: portal login/catalog/API readiness, bounded timeout, redirect target and crash-during-probe checks'

for staged in no yes; do
  setup_case "dirty-glossary-$staged"
  echo vps-edit >> "$app/GLOSSARY.md"
  if [[ "$staged" == yes ]]; then git -C "$app" add GLOSSARY.md; fi
  if bash "$home/deploy.sh" "$target" > "$home/output" 2>&1; then exit 1; fi
  grep -q 'code changes block deployment' "$home/output"
  assert_untouched
  [[ "$(tail -n 1 "$app/GLOSSARY.md")" == vps-edit ]]
done
echo 'PASS: staged and unstaged VPS GLOSSARY edits remain guarded, never reconciled automatically'
