#!/bin/zsh

set -euo pipefail

ECHO_PROJECT_ROOT="${0:A:h:h}"
cd "$ECHO_PROJECT_ROOT"

if [[ ! -f .env ]]; then
  print -u2 "缺少 $ECHO_PROJECT_ROOT/.env"
  exit 1
fi

set -a
source .env
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  print -u2 ".env 中未配置 DATABASE_URL"
  exit 1
fi

ECHO_SNAPSHOT_PATH="${1:-.echo-snapshots/clean-baseline.dump}"
if [[ "$ECHO_SNAPSHOT_PATH" != /* ]]; then
  ECHO_SNAPSHOT_PATH="$ECHO_PROJECT_ROOT/$ECHO_SNAPSHOT_PATH"
fi
mkdir -p "${ECHO_SNAPSHOT_PATH:h}"

ECHO_PSQL_URL="${DATABASE_URL%%\?*}"
ECHO_SERVER_VERSION_NUM="$(psql "$ECHO_PSQL_URL" --tuples-only --no-align --command='SHOW server_version_num')"
ECHO_SERVER_MAJOR="$(( ECHO_SERVER_VERSION_NUM / 10000 ))"
ECHO_POSTGRES_BIN="${ECHO_POSTGRES_BIN:-/opt/homebrew/opt/postgresql@${ECHO_SERVER_MAJOR}/bin}"
if [[ ! -x "$ECHO_POSTGRES_BIN/pg_dump" ]]; then
  ECHO_POSTGRES_BIN=""
fi
ECHO_PG_DUMP="${ECHO_POSTGRES_BIN:+$ECHO_POSTGRES_BIN/}pg_dump"
ECHO_PG_RESTORE="${ECHO_POSTGRES_BIN:+$ECHO_POSTGRES_BIN/}pg_restore"
ECHO_SNAPSHOT_TMP="$(mktemp "${TMPDIR:-/tmp}/echo-database-snapshot.XXXXXX")"
trap 'rm -f "$ECHO_SNAPSHOT_TMP"' EXIT

"$ECHO_PG_DUMP" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$ECHO_SNAPSHOT_TMP" \
  "$ECHO_PSQL_URL"

"$ECHO_PG_RESTORE" --list "$ECHO_SNAPSHOT_TMP" >/dev/null
mv "$ECHO_SNAPSHOT_TMP" "$ECHO_SNAPSHOT_PATH"
shasum -a 256 "$ECHO_SNAPSHOT_PATH" > "$ECHO_SNAPSHOT_PATH.sha256"
trap - EXIT

print "数据库快照已保存：$ECHO_SNAPSHOT_PATH"
print "校验文件已保存：$ECHO_SNAPSHOT_PATH.sha256"
