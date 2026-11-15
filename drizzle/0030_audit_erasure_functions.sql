-- The app role may only read and add audit rows (deploy/db-roles.sql). Deleting a person
-- (Admin -> People -> Delete, and the scheduled scrub) must still remove the audit rows about
-- them and redact their name from the rest, so it does that through these two functions,
-- which run with their owner's rights and do nothing else.
CREATE OR REPLACE FUNCTION "public"."ooohm_erase_audit_about"(p_company_id uuid, p_user_id text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH erased AS (
    DELETE FROM public.audit_log
    WHERE company_id = p_company_id
      AND (subject_user_id = p_user_id OR (entity_type = 'user' AND entity_id = p_user_id))
    RETURNING 1
  )
  SELECT count(*)::integer FROM erased;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."ooohm_redact_audit_snapshots"(p_id uuid, p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.audit_log SET before = p_before, after = p_after WHERE id = p_id;
$$;
