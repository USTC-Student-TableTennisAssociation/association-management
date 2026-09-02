#!/bin/zsh

set -euo pipefail

SYDARIS_PROJECT_ROOT="${0:A:h:h}"
cd "$SYDARIS_PROJECT_ROOT"

SYDARIS_SNAPSHOT_PATH=".sydaris-snapshots/clean-baseline.dump"
SYDARIS_RESTORE_CONFIRMED="false"
for SYDARIS_ARGUMENT in "$@"; do
  if [[ "$SYDARIS_ARGUMENT" == "--yes" ]]; then
    SYDARIS_RESTORE_CONFIRMED="true"
  else
    SYDARIS_SNAPSHOT_PATH="$SYDARIS_ARGUMENT"
  fi
done

if [[ "$SYDARIS_RESTORE_CONFIRMED" != "true" ]]; then
  print -u2 "恢复会覆盖当前数据库。确认后运行：npm run db:restore -- --yes"
  exit 2
fi

if [[ "$SYDARIS_SNAPSHOT_PATH" != /* ]]; then
  SYDARIS_SNAPSHOT_PATH="$SYDARIS_PROJECT_ROOT/$SYDARIS_SNAPSHOT_PATH"
fi
if [[ ! -f "$SYDARIS_SNAPSHOT_PATH" ]]; then
  print -u2 "数据库快照不存在：$SYDARIS_SNAPSHOT_PATH"
  exit 1
fi
if [[ ! -f .env ]]; then
  print -u2 "缺少 $SYDARIS_PROJECT_ROOT/.env"
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  set -a
  source .env
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  print -u2 ".env 中未配置 DATABASE_URL"
  exit 1
fi

if [[ -f "$SYDARIS_SNAPSHOT_PATH.sha256" ]]; then
  (cd "${SYDARIS_SNAPSHOT_PATH:h}" && shasum -a 256 -c "${SYDARIS_SNAPSHOT_PATH:t}.sha256")
fi

SYDARIS_PSQL_URL="${DATABASE_URL%%\?*}"
SYDARIS_SERVER_VERSION_NUM="$(psql "$SYDARIS_PSQL_URL" --tuples-only --no-align --command='SHOW server_version_num')"
SYDARIS_SERVER_MAJOR="$(( SYDARIS_SERVER_VERSION_NUM / 10000 ))"
SYDARIS_POSTGRES_BIN="${SYDARIS_POSTGRES_BIN:-/opt/homebrew/opt/postgresql@${SYDARIS_SERVER_MAJOR}/bin}"
if [[ ! -x "$SYDARIS_POSTGRES_BIN/pg_restore" ]]; then
  SYDARIS_POSTGRES_BIN=""
fi
SYDARIS_PG_RESTORE="${SYDARIS_POSTGRES_BIN:+$SYDARIS_POSTGRES_BIN/}pg_restore"
SYDARIS_PSQL="${SYDARIS_POSTGRES_BIN:+$SYDARIS_POSTGRES_BIN/}psql"
SYDARIS_CLEANUP_SQL="$SYDARIS_PROJECT_ROOT/scripts/database-clear-application.sql"
SYDARIS_RESTORE_LIST="$(mktemp "${TMPDIR:-/tmp}/sydaris-database-restore-list.XXXXXX")"
SYDARIS_RESTORE_BODY="$(mktemp "${TMPDIR:-/tmp}/sydaris-database-restore-body.XXXXXX")"
SYDARIS_RESTORE_SQL="$(mktemp "${TMPDIR:-/tmp}/sydaris-database-restore.XXXXXX")"
trap 'rm -f "$SYDARIS_RESTORE_LIST" "$SYDARIS_RESTORE_BODY" "$SYDARIS_RESTORE_SQL"' EXIT

if [[ ! -f "$SYDARIS_CLEANUP_SQL" ]]; then
  print -u2 "缺少应用数据库清理脚本：$SYDARIS_CLEANUP_SQL"
  exit 1
fi

# 扩展由数据库环境管理，应用账号通常不是其 owner。保留所有扩展，
# 只替换 public schema 中由当前应用账号拥有的关系、函数与类型。
# 清理与 restore SQL 在同一个 transaction 中执行，失败不会留下半恢复状态。
"$SYDARIS_PG_RESTORE" --list "$SYDARIS_SNAPSHOT_PATH" \
  | rg -v ' (EXTENSION -|COMMENT - EXTENSION) ' \
  > "$SYDARIS_RESTORE_LIST"

"$SYDARIS_PG_RESTORE" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --use-list="$SYDARIS_RESTORE_LIST" \
  --file="$SYDARIS_RESTORE_BODY" \
  "$SYDARIS_SNAPSHOT_PATH"

{
  print "SET client_min_messages TO warning;"
  command cat "$SYDARIS_CLEANUP_SQL"
  command cat "$SYDARIS_RESTORE_BODY"
} > "$SYDARIS_RESTORE_SQL"

"$SYDARIS_PSQL" "$SYDARIS_PSQL_URL" \
  --quiet \
  --set=ON_ERROR_STOP=1 \
  --single-transaction \
  --file="$SYDARIS_RESTORE_SQL"

trap - EXIT
rm -f "$SYDARIS_RESTORE_LIST" "$SYDARIS_RESTORE_BODY" "$SYDARIS_RESTORE_SQL"

print "数据库已恢复到快照：$SYDARIS_SNAPSHOT_PATH"
