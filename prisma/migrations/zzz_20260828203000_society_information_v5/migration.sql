-- Compatible Society Information v5 upgrade.
--
-- v5 adds direct-management presentation flows and only makes additive Card
-- Schema changes (new enum options and richer semantic descriptions). Existing
-- v3 Card values and Slot bindings remain valid.

UPDATE "installed_views"
   SET "module_version" = '1.10.0',
       "schema_version" = '5',
       "status" = 'enabled',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "view_key" = 'society_information';
