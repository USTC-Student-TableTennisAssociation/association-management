-- Clear only application-owned objects in the public schema. Extensions and
-- objects owned by other roles remain database-environment responsibilities.
DO $cleanup_relations$
DECLARE
  target record;
  object_kind text;
BEGIN
  FOR target IN
    SELECT
      class.oid,
      class.relkind,
      namespace.nspname AS schema_name,
      class.relname AS object_name
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND pg_get_userbyid(class.relowner) = current_user
      AND class.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_class'::regclass
          AND dependency.objid = class.oid
          AND dependency.deptype = 'e'
      )
    ORDER BY CASE class.relkind
      WHEN 'v' THEN 1
      WHEN 'm' THEN 2
      WHEN 'f' THEN 3
      WHEN 'p' THEN 4
      WHEN 'r' THEN 5
      WHEN 'S' THEN 6
    END,
    class.relname
  LOOP
    object_kind := CASE target.relkind
      WHEN 'r' THEN 'TABLE'
      WHEN 'p' THEN 'TABLE'
      WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'S' THEN 'SEQUENCE'
      WHEN 'f' THEN 'FOREIGN TABLE'
    END;
    EXECUTE format(
      'DROP %s IF EXISTS %I.%I CASCADE',
      object_kind,
      target.schema_name,
      target.object_name
    );
  END LOOP;
END
$cleanup_relations$;

DO $cleanup_routines$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT
      procedure.oid,
      namespace.nspname AS schema_name,
      procedure.proname AS routine_name,
      pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND pg_get_userbyid(procedure.proowner) = current_user
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = procedure.oid
          AND dependency.deptype = 'e'
      )
    ORDER BY procedure.proname, procedure.oid
  LOOP
    EXECUTE format(
      'DROP ROUTINE IF EXISTS %I.%I(%s) CASCADE',
      target.schema_name,
      target.routine_name,
      target.identity_arguments
    );
  END LOOP;
END
$cleanup_routines$;

DO $cleanup_types$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT
      type.oid,
      namespace.nspname AS schema_name,
      type.typname AS type_name
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND pg_get_userbyid(type.typowner) = current_user
      AND type.typtype IN ('b', 'c', 'd', 'e', 'm', 'r')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_type'::regclass
          AND dependency.objid = type.oid
          AND dependency.deptype IN ('e', 'i')
      )
    ORDER BY type.typname
  LOOP
    EXECUTE format(
      'DROP TYPE IF EXISTS %I.%I CASCADE',
      target.schema_name,
      target.type_name
    );
  END LOOP;
END
$cleanup_types$;
