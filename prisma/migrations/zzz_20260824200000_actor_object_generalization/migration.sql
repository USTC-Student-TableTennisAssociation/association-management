ALTER TABLE "auth_users"
  RENAME COLUMN "person_object_id" TO "actor_object_id";

ALTER TABLE "auth_users"
  RENAME CONSTRAINT "auth_users_person_object_id_fkey" TO "auth_users_actor_object_id_fkey";

ALTER INDEX "auth_users_person_object_id_key"
  RENAME TO "auth_users_actor_object_id_key";
