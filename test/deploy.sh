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
echo v22.23.2
EOF
cat > "$mocks/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -n ]] && shift
[[ "$1" == -l ]] && exit 0
exec "$@"
EOF
cat > "$mocks/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
case "$*" in
  'show random-fun-bot -p MainPID --value') echo 123 ;;
  'show random-fun-bot -p NRestarts --value') echo 0 ;;
esac
EOF
cat > "$mocks/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
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
exit 0
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
  sed -e "s|/home/ubuntu|$home|g" \
      -e "s|systemctl=/usr/bin/systemctl|systemctl=$mocks/systemctl|" \
      "$source_script" > "$home/deploy.sh"
  export FAKE_LOG="$home/service.log" FAKE_NPM_FAIL=0 FAKE_LOCK_FAIL=0
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

setup_case preserve-data
bash "$home/deploy.sh" "$target" > "$home/output" 2>&1 || { cat "$home/output"; exit 1; }
[[ "$(git -C "$app" rev-parse HEAD)" == "$target" ]]
[[ "$(cat "$app/node_modules/version")" == new ]]
grep -q '^systemctl restart random-fun-bot$' "$FAKE_LOG"
assert_data
echo 'PASS: deploy tested code and dependencies, preserving staged and untracked data'

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
