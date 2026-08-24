-- Compatible Society Information v3 upgrade.
--
-- v3 adds optional PersonCard dimensions (department and position) plus the
-- SocietyCard.team slot. Existing cards and bindings remain valid, so this
-- migration only advances the installed contract version.

UPDATE "installed_views"
   SET "module_version" = '1.2.0',
       "schema_version" = '3',
       "status" = 'enabled',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "view_key" = 'society_information';
