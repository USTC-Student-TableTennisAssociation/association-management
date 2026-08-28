-- Compatible Activity Operations v3 upgrade.
--
-- v3 adds reusable nested Playbooks, generated task definitions, source links,
-- and authorable dependency maps. Every new Dimension and Slot is additive, so
-- existing runtime Activity, Work Package and Task Cards remain valid.

UPDATE "installed_views"
   SET "module_version" = '1.2.0',
       "schema_version" = '3',
       "status" = 'enabled',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "view_key" = 'activity_operations';
