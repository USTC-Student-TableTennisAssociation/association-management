import { Pool } from "pg";

import type { ToolProviderExtension } from "@/contracts";
import {
  COMPETITION_SOURCE_READ_CAPABILITY,
  COMPETITION_TOOL_CAPABILITY_VERSION,
  type CompetitionSourceBatch,
  type CompetitionSourceReadInput,
  type SourceCompetitionRecord,
  USTCTTA_SOURCE_SYSTEM,
  USTCTTA_SOURCE_PROVIDER_ID,
} from "@/plugins/competition-records/tools/contracts";

type SourceRow = {
  sourceId: string;
  title: string;
  description: string | null;
  dateTime: Date | string;
  heldOn: string;
  location: string | null;
  isQuickMatch: boolean;
  matchType: "single" | "double" | "team";
  status: "registration" | "ongoing" | "finished";
  format: "group_only" | "group_then_knockout";
  maxParticipants: number;
  registrationDeadline: Date | string;
  participantCount: number;
  participantCountBasis: SourceCompetitionRecord["participantCountBasis"];
  competitorUnitCount: number;
  resultCount: number;
  sourceCreatedAt: Date | string;
  sourceUpdatedAt: Date | string;
};

export type UstcttaCompetitionQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<readonly SourceRow[]>;

type SourceCursor = {
  dateTime: string;
  sourceId: string;
};

export type UstcttaCompetitionSnapshotSession = {
  sourceSnapshotAt: string;
  query: UstcttaCompetitionQuery;
};

export type UstcttaCompetitionSnapshotRunner = <Result>(
  read: (session: UstcttaCompetitionSnapshotSession) => Promise<Result>,
) => Promise<Result>;

const SOURCE_PAGE_SIZE = 200;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sourceDatabaseUrl(): string {
  const value = process.env.USTCTTA_DATABASE_URL?.trim() ||
    process.env.USTCTTA_DATABASE_URL_UNPOOLED?.trim();
  if (!value) {
    throw new Error(
      "未配置 USTCTTA_DATABASE_URL（或 USTCTTA_DATABASE_URL_UNPOOLED），无法读取比赛源数据",
    );
  }
  const url = new URL(value);
  if (url.searchParams.get("sslmode") === "require") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

async function withDatabaseSnapshot<Result>(
  read: (session: UstcttaCompetitionSnapshotSession) => Promise<Result>,
): Promise<Result> {
  const pool = new Pool({
    connectionString: sourceDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 60_000,
    idleTimeoutMillis: 5_000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await client.query<{ sourceSnapshotAt: Date | string }>(
      'SELECT statement_timestamp() AS "sourceSnapshotAt"',
    );
    const sourceSnapshotAt = snapshot.rows[0]?.sourceSnapshotAt;
    if (!sourceSnapshotAt) throw new Error("无法取得 USTCTTA 数据库快照时间");
    const result = await read({
      sourceSnapshotAt: iso(sourceSnapshotAt),
      query: async (text, values) =>
        (await client.query<SourceRow>(text, [...values])).rows,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function pageQuery(
  input: CompetitionSourceReadInput,
  cursor: SourceCursor | undefined,
  pageSize: number,
): { text: string; values: readonly unknown[] } {
  const values: unknown[] = [];
  const filters: string[] = [];
  if (!input.includeQuickMatches) filters.push('NOT m."isQuickMatch"');
  if (input.sourceIds !== undefined) {
    values.push(input.sourceIds);
    filters.push(`m.id = ANY($${values.length}::text[])`);
  }
  if (input.heldOnFrom) {
    values.push(input.heldOnFrom);
    filters.push(`m."dateTime"::date >= $${values.length}::date`);
  }
  if (input.heldOnThrough) {
    values.push(input.heldOnThrough);
    filters.push(`m."dateTime"::date <= $${values.length}::date`);
  }
  if (cursor) {
    values.push(cursor.dateTime, cursor.sourceId);
    filters.push(
      `(m."dateTime", m.id) < ($${values.length - 1}::timestamptz, $${values.length}::text)`,
    );
  }
  values.push(pageSize + 1);

  return {
    values,
    text: `
    SELECT
      m.id AS "sourceId",
      m.title,
      m.description,
      m."dateTime" AS "dateTime",
      to_char(m."dateTime"::date, 'YYYY-MM-DD') AS "heldOn",
      m.location,
      m."isQuickMatch" AS "isQuickMatch",
      m.type::text AS "matchType",
      m.status::text AS status,
      m.format::text AS format,
      m."maxParticipants" AS "maxParticipants",
      m."registrationDeadline" AS "registrationDeadline",
      CASE m.type::text
        WHEN 'double' THEN COALESCE(doubles.participant_count, 0)
        WHEN 'team' THEN COALESCE(teams.participant_count, 0)
        ELSE COALESCE(individuals.participant_count, 0)
      END::int AS "participantCount",
      CASE m.type::text
        WHEN 'double' THEN 'registered_doubles_team_members'
        WHEN 'team' THEN 'approved_team_members'
        ELSE 'active_individual_registrations'
      END AS "participantCountBasis",
      CASE m.type::text
        WHEN 'double' THEN COALESCE(doubles.competitor_count, 0)
        WHEN 'team' THEN COALESCE(teams.competitor_count, 0)
        ELSE COALESCE(individuals.participant_count, 0)
      END::int AS "competitorUnitCount",
      COALESCE(results.result_count, 0)::int AS "resultCount",
      m."createdAt" AS "sourceCreatedAt",
      m."updatedAt" AS "sourceUpdatedAt"
    FROM "Match" m
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT r."userId")::int AS participant_count
      FROM "Registration" r
      JOIN "User" u ON u.id = r."userId" AND NOT u."isBanned"
      WHERE r."matchId" = m.id
        AND r.status::text IN ('registered', 'confirmed')
    ) individuals ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT member.user_id)::int AS participant_count,
        COUNT(DISTINCT team.id)::int AS competitor_count
      FROM match_doubles_team team
      JOIN match_doubles_team_member member ON member.team_id = team.id
      WHERE team.match_id = m.id
        AND team.registered_at IS NOT NULL
        AND (SELECT COUNT(*) FROM match_doubles_team_member all_member
             WHERE all_member.team_id = team.id) = 2
        AND NOT EXISTS (
          SELECT 1
          FROM match_doubles_team_member banned_member
          JOIN "User" banned_user ON banned_user.id = banned_member.user_id
          WHERE banned_member.team_id = team.id AND banned_user."isBanned"
        )
    ) doubles ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT member.user_id)::int AS participant_count,
        COUNT(DISTINCT team.id)::int AS competitor_count
      FROM match_team team
      JOIN match_team_member member ON member.team_id = team.id
      WHERE team.match_id = m.id
        AND team.status::text = 'approved'
        AND NOT EXISTS (
          SELECT 1
          FROM match_team_member banned_member
          JOIN "User" banned_user ON banned_user.id = banned_member.user_id
          WHERE banned_member.team_id = team.id AND banned_user."isBanned"
        )
    ) teams ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS result_count
      FROM "MatchResult" result
      WHERE result."matchId" = m.id
    ) results ON true
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY m."dateTime" DESC, m.id DESC
    LIMIT $${values.length}::int
  `,
  };
}

export async function readUstcttaCompetitionData(
  input: CompetitionSourceReadInput,
  dependencies: {
    runInSnapshot?: UstcttaCompetitionSnapshotRunner;
    pageSize?: number;
  } = {},
): Promise<CompetitionSourceBatch> {
  const pageSize = dependencies.pageSize ?? SOURCE_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Source Adapter 内部分页大小必须是正整数");
  }
  return (dependencies.runInSnapshot ?? withDatabaseSnapshot)(async (session) => {
    const rows: SourceRow[] = [];
    let cursor: SourceCursor | undefined;
    let pageCount = 0;
    for (;;) {
      const query = pageQuery(input, cursor, pageSize);
      const fetched = await session.query(query.text, query.values);
      pageCount += 1;
      const hasMore = fetched.length > pageSize;
      const page = fetched.slice(0, pageSize);
      rows.push(...page);
      if (!hasMore) break;
      const last = page.at(-1);
      if (!last) throw new Error("USTCTTA 分页游标无法前进");
      const nextCursor = {
        dateTime: iso(last.dateTime),
        sourceId: last.sourceId,
      };
      if (
        cursor?.dateTime === nextCursor.dateTime &&
        cursor.sourceId === nextCursor.sourceId
      ) {
        throw new Error("USTCTTA 分页游标重复，已终止读取以避免死循环");
      }
      cursor = nextCursor;
    }

    return {
      sourceSystem: USTCTTA_SOURCE_SYSTEM,
      sourceSchemaVersion: "1",
      sourceSnapshotAt: session.sourceSnapshotAt,
      complete: true,
      pageCount,
      records: rows.map((row) => ({
        sourceId: row.sourceId,
        title: row.title,
        description: row.description,
        dateTime: iso(row.dateTime),
        heldOn: row.heldOn,
        location: row.location,
        isQuickMatch: row.isQuickMatch,
        matchType: row.matchType,
        status: row.status,
        format: row.format,
        maxParticipants: Number(row.maxParticipants),
        registrationDeadline: iso(row.registrationDeadline),
        participantCount: Number(row.participantCount),
        participantCountBasis: row.participantCountBasis,
        competitorUnitCount: Number(row.competitorUnitCount),
        resultCount: Number(row.resultCount),
        sourceCreatedAt: iso(row.sourceCreatedAt),
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
      })),
    };
  });
}

export const ustcttaCompetitionSourceProvider: ToolProviderExtension = {
  id: USTCTTA_SOURCE_PROVIDER_ID,
  version: "2.0.0",
  implementations: [{
    capability: {
      key: COMPETITION_SOURCE_READ_CAPABILITY,
      version: COMPETITION_TOOL_CAPABILITY_VERSION,
    },
    execute: async (_context, input) =>
      readUstcttaCompetitionData(input as CompetitionSourceReadInput),
  }],
};
