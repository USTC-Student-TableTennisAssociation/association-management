#!/bin/zsh

set -euo pipefail

ECHO_PROJECT_ROOT="${0:A:h:h}"
cd "$ECHO_PROJECT_ROOT"

ECHO_SNAPSHOT_PATH=".echo-snapshots/clean-baseline.dump"
ECHO_RESTORE_CONFIRMED="false"
for ECHO_ARGUMENT in "$@"; do
  if [[ "$ECHO_ARGUMENT" == "--yes" ]]; then
    ECHO_RESTORE_CONFIRMED="true"
  else
    ECHO_SNAPSHOT_PATH="$ECHO_ARGUMENT"
  fi
done

if [[ "$ECHO_RESTORE_CONFIRMED" != "true" ]]; then
  print -u2 "恢复会覆盖当前数据库。确认后运行：npm run db:restore -- --yes"
  exit 2
fi

if [[ "$ECHO_SNAPSHOT_PATH" != /* ]]; then
  ECHO_SNAPSHOT_PATH="$ECHO_PROJECT_ROOT/$ECHO_SNAPSHOT_PATH"
fi
if [[ ! -f "$ECHO_SNAPSHOT_PATH" ]]; then
  print -u2 "数据库快照不存在：$ECHO_SNAPSHOT_PATH"
  exit 1
fi
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

if [[ -f "$ECHO_SNAPSHOT_PATH.sha256" ]]; then
  (cd "${ECHO_SNAPSHOT_PATH:h}" && shasum -a 256 -c "${ECHO_SNAPSHOT_PATH:t}.sha256")
fi

ECHO_PSQL_URL="${DATABASE_URL%%\?*}"
ECHO_SERVER_VERSION_NUM="$(psql "$ECHO_PSQL_URL" --tuples-only --no-align --command='SHOW server_version_num')"
ECHO_SERVER_MAJOR="$(( ECHO_SERVER_VERSION_NUM / 10000 ))"
ECHO_POSTGRES_BIN="${ECHO_POSTGRES_BIN:-/opt/homebrew/opt/postgresql@${ECHO_SERVER_MAJOR}/bin}"
if [[ ! -x "$ECHO_POSTGRES_BIN/pg_restore" ]]; then
  ECHO_POSTGRES_BIN=""
fi
ECHO_PG_RESTORE="${ECHO_POSTGRES_BIN:+$ECHO_POSTGRES_BIN/}pg_restore"
ECHO_RESTORE_LIST="$(mktemp "${TMPDIR:-/tmp}/echo-database-restore-list.XXXXXX")"
trap 'rm -f "$ECHO_RESTORE_LIST"' EXIT

# 扩展由数据库环境管理，应用账号通常不是其 owner。保留所有扩展，
# 只清理并恢复快照中属于应用自身的 Schema 对象。
"$ECHO_PG_RESTORE" --list "$ECHO_SNAPSHOT_PATH" \
  | rg -v ' (EXTENSION -|COMMENT - EXTENSION) ' \
  > "$ECHO_RESTORE_LIST"

"$ECHO_PG_RESTORE" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --single-transaction \
  --use-list="$ECHO_RESTORE_LIST" \
  --dbname="$ECHO_PSQL_URL" \
  "$ECHO_SNAPSHOT_PATH"

trap - EXIT
rm -f "$ECHO_RESTORE_LIST"

print "数据库已恢复到快照：$ECHO_SNAPSHOT_PATH"
