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

set -a
source .env
set +a

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
SYDARIS_RESTORE_LIST="$(mktemp "${TMPDIR:-/tmp}/sydaris-database-restore-list.XXXXXX")"
trap 'rm -f "$SYDARIS_RESTORE_LIST"' EXIT

# 扩展由数据库环境管理，应用账号通常不是其 owner。保留所有扩展，
# 只清理并恢复快照中属于应用自身的 Schema 对象。
"$SYDARIS_PG_RESTORE" --list "$SYDARIS_SNAPSHOT_PATH" \
  | rg -v ' (EXTENSION -|COMMENT - EXTENSION) ' \
  > "$SYDARIS_RESTORE_LIST"

"$SYDARIS_PG_RESTORE" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --single-transaction \
  --use-list="$SYDARIS_RESTORE_LIST" \
  --dbname="$SYDARIS_PSQL_URL" \
  "$SYDARIS_SNAPSHOT_PATH"

trap - EXIT
rm -f "$SYDARIS_RESTORE_LIST"

print "数据库已恢复到快照：$SYDARIS_SNAPSHOT_PATH"
