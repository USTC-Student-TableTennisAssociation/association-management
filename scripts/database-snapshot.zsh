#!/bin/zsh

set -euo pipefail

SYDARIS_PROJECT_ROOT="${0:A:h:h}"
cd "$SYDARIS_PROJECT_ROOT"

if [[ ! -f .env ]]; then
  print -u2 "缺少 $SYDARIS_PROJECT_ROOT/.env"
  exit 1
fi

set -a
source .env
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  print -u2 ".env 中未配置 DATABASE_URL"
  exit 1
fi

SYDARIS_SNAPSHOT_PATH="${1:-.sydaris-snapshots/clean-baseline.dump}"
if [[ "$SYDARIS_SNAPSHOT_PATH" != /* ]]; then
  SYDARIS_SNAPSHOT_PATH="$SYDARIS_PROJECT_ROOT/$SYDARIS_SNAPSHOT_PATH"
fi
mkdir -p "${SYDARIS_SNAPSHOT_PATH:h}"

SYDARIS_PSQL_URL="${DATABASE_URL%%\?*}"
SYDARIS_SERVER_VERSION_NUM="$(psql "$SYDARIS_PSQL_URL" --tuples-only --no-align --command='SHOW server_version_num')"
SYDARIS_SERVER_MAJOR="$(( SYDARIS_SERVER_VERSION_NUM / 10000 ))"
SYDARIS_POSTGRES_BIN="${SYDARIS_POSTGRES_BIN:-/opt/homebrew/opt/postgresql@${SYDARIS_SERVER_MAJOR}/bin}"
if [[ ! -x "$SYDARIS_POSTGRES_BIN/pg_dump" ]]; then
  SYDARIS_POSTGRES_BIN=""
fi
SYDARIS_PG_DUMP="${SYDARIS_POSTGRES_BIN:+$SYDARIS_POSTGRES_BIN/}pg_dump"
SYDARIS_PG_RESTORE="${SYDARIS_POSTGRES_BIN:+$SYDARIS_POSTGRES_BIN/}pg_restore"
SYDARIS_SNAPSHOT_TMP="$(mktemp "${TMPDIR:-/tmp}/sydaris-database-snapshot.XXXXXX")"
trap 'rm -f "$SYDARIS_SNAPSHOT_TMP"' EXIT

"$SYDARIS_PG_DUMP" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$SYDARIS_SNAPSHOT_TMP" \
  "$SYDARIS_PSQL_URL"

"$SYDARIS_PG_RESTORE" --list "$SYDARIS_SNAPSHOT_TMP" >/dev/null
mv "$SYDARIS_SNAPSHOT_TMP" "$SYDARIS_SNAPSHOT_PATH"
shasum -a 256 "$SYDARIS_SNAPSHOT_PATH" > "$SYDARIS_SNAPSHOT_PATH.sha256"
trap - EXIT

print "数据库快照已保存：$SYDARIS_SNAPSHOT_PATH"
print "校验文件已保存：$SYDARIS_SNAPSHOT_PATH.sha256"
