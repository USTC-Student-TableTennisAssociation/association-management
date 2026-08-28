-- Compatible Activity Operations v2 upgrade.
--
-- v2 enriches the plugin-owned Card Schema and adds a dedicated Presentation,
-- update Commands and business invariants. Existing v1 Activity, Work Package,
-- Task and Assignment Cards remain valid because all newly introduced stored
-- fields and Slots are backward-compatible.

UPDATE "installed_views"
   SET "module_version" = '1.1.0',
       "schema_version" = '2',
       "status" = 'enabled',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "view_key" = 'activity_operations';
