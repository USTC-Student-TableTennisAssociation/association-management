-- Development-stage destructive upgrade for Society Information v2.
--
-- Reset only the society_information View Runtime state. Shared cognitive
-- Objects, Assertions, Evidence, source documents, users, conversations and
-- every other View remain untouched. The v2 View will be initialized again
-- through society.initialize_overview after deployment.

DELETE FROM "view_command_proposals"
 WHERE "view_key" = 'society_information';

DELETE FROM "view_command_executions"
 WHERE "view_key" = 'society_information';

DELETE FROM "domain_event_outbox"
 WHERE "view_key" = 'society_information';

DELETE FROM "view_higher_memories"
 WHERE "view_key" = 'society_information';

-- Remove bindings explicitly before Cards because target bindings use
-- ON DELETE RESTRICT. This also protects the reset if pre-v1 development data
-- happened to contain a cross-View binding.
DELETE FROM "view_slot_bindings"
 WHERE "source_card_id" IN (
         SELECT "id" FROM "view_cards"
          WHERE "view_key" = 'society_information'
       )
    OR "target_card_id" IN (
         SELECT "id" FROM "view_cards"
          WHERE "view_key" = 'society_information'
       );

-- Dimensions and Related Objects cascade with their View Cards.
DELETE FROM "view_cards"
 WHERE "view_key" = 'society_information';

-- Keep installation settings, but reset the formal state and contract version.
-- If the View has not been installed yet, InstalledViewService will create it
-- from the v2 module on first startup.
UPDATE "installed_views"
   SET "module_version" = '1.1.0',
       "schema_version" = '2',
       "state_version" = 0,
       "status" = 'enabled',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "view_key" = 'society_information';
