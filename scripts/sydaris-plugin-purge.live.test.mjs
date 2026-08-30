import "dotenv/config";

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { purgeViewData } from "./sydaris-plugin.mjs";

const runLive = process.env.SYDARIS_LIVE_PLUGIN_PURGE_TEST === "1";
const pool = runLive ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

describe.runIf(runLive)("Plugin --purge database cleanup", () => {
  afterAll(async () => {
    await pool?.end();
  });

  it("removes an Installed View and every owned runtime row", async () => {
    const client = await pool.connect();
    const viewKey = `plugin_purge_test_${randomUUID()}`;
    const cardOne = randomUUID();
    const cardTwo = randomUUID();
    try {
      await client.query(
        `INSERT INTO "installed_views"
          ("view_key", "module_id", "module_version", "schema_version", "settings_json",
           "created_at", "updated_at")
         VALUES ($1, 'sydaris.test-purge', '1.0.0', '1', '{"aiWritePolicy":"approval_required"}'::jsonb,
           now(), now())`,
        [viewKey],
      );
      await client.query(
        `INSERT INTO "view_cards" ("id", "view_key", "card_type_key", "created_at", "updated_at")
         VALUES ($1, $3, 'TestCard', now(), now()), ($2, $3, 'TestCard', now(), now())`,
        [cardOne, cardTwo, viewKey],
      );
      await client.query(
        `INSERT INTO "view_dimension_values"
          ("card_id", "dimension_key", "value_json", "created_at", "updated_at")
         VALUES ($1, 'name', '"test"'::jsonb, now(), now())`,
        [cardOne],
      );
      await client.query(
        `INSERT INTO "view_slot_bindings" ("source_card_id", "slot_key", "target_card_id")
         VALUES ($1, 'next', $2)`,
        [cardOne, cardTwo],
      );
      await client.query(
        `INSERT INTO "view_command_proposals"
          ("id", "view_key", "command_key", "command_version", "input_json", "expected_state_version")
         VALUES ($1, $2, 'test.create', '1', '{}'::jsonb, 0)`,
        [randomUUID(), viewKey],
      );
      await client.query(
        `INSERT INTO "view_command_executions"
          ("id", "view_key", "command_key", "command_version", "input_json", "initiator",
           "state_version_before", "state_version_after")
         VALUES ($1, $2, 'test.create', '1', '{}'::jsonb, 'system', 0, 1)`,
        [randomUUID(), viewKey],
      );
      await client.query(
        `INSERT INTO "view_higher_memories"
          ("id", "view_key", "content_markdown", "maintained_at", "maintenance_reason",
           "created_at", "updated_at")
         VALUES ($1, $2, 'test', now(), 'plugin purge live test', now(), now())`,
        [randomUUID(), viewKey],
      );

      const result = await purgeViewData(client, [viewKey]);
      expect(result.statements).toBe(8);
      const checks = [];
      for (const table of [
        "installed_views",
        "view_cards",
        "view_command_proposals",
        "view_command_executions",
        "view_higher_memories",
      ]) {
        checks.push(await client.query(
          `SELECT count(*)::int AS count FROM "${table}" WHERE "view_key" = $1`,
          [viewKey],
        ));
      }
      checks.push(
        await client.query(
          `SELECT count(*)::int AS count FROM "view_dimension_values" WHERE "card_id" = ANY($1::uuid[])`,
          [[cardOne, cardTwo]],
        ),
        await client.query(
          `SELECT count(*)::int AS count FROM "view_slot_bindings"
           WHERE "source_card_id" = ANY($1::uuid[]) OR "target_card_id" = ANY($1::uuid[])`,
          [[cardOne, cardTwo]],
        ),
      );
      expect(checks.map((check) => check.rows[0].count)).toEqual(Array(checks.length).fill(0));
    } finally {
      await purgeViewData(client, [viewKey]);
      client.release();
    }
  });
});
