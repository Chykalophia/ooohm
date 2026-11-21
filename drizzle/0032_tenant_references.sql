-- Review fixes to row-level security (ADR-0004, drizzle/0031_row_level_security.sql).
-- 0031 stays as it was; everything here changes what it left.

-- 1. Better Auth's views are gone. They read the identity tables as the owner, past row
-- security, and the app role could write through them. Better Auth now reaches the tables
-- themselves in the person's company (src/lib/auth-adapter.ts), finding that company first
-- through the narrow lookups below.
DROP VIEW "public"."auth_user";--> statement-breakpoint
DROP VIEW "public"."auth_session";--> statement-breakpoint
DROP VIEW "public"."auth_account";--> statement-breakpoint
DROP VIEW "public"."auth_passkey";--> statement-breakpoint

-- Sign-in: a person's company and whether they are active, by id or by email (lowercased,
-- as stored). Nothing else of the person.
CREATE FUNCTION "public"."ooohm_auth_person"(p_user_id text, p_email text)
RETURNS TABLE (company_id uuid, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.company_id, u.is_active FROM public."user" u WHERE u.id = p_user_id OR u.email = p_email LIMIT 1
$$;--> statement-breakpoint

-- Sign-in: the company of the person a session token belongs to.
CREATE FUNCTION "public"."ooohm_auth_session_company"(p_token text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.company_id FROM public.session s JOIN public."user" u ON u.id = s.user_id WHERE s.token = p_token
$$;--> statement-breakpoint

-- Sign-in: the company of an account's person, by the account's id or its provider's account id.
CREATE FUNCTION "public"."ooohm_auth_account_company"(p_id text, p_provider_id text, p_account_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.company_id FROM public.account a JOIN public."user" u ON u.id = a.user_id
  WHERE a.id = p_id OR (a.provider_id = p_provider_id AND a.account_id = p_account_id)
  LIMIT 1
$$;--> statement-breakpoint

-- Sign-in: the company of a passkey's person, by the passkey's id or its credential id.
CREATE FUNCTION "public"."ooohm_auth_passkey_company"(p_id text, p_credential_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.company_id FROM public.passkey k JOIN public."user" u ON u.id = k.user_id
  WHERE k.id = p_id OR k.credential_id = p_credential_id
  LIMIT 1
$$;--> statement-breakpoint

-- 2. Narrower pre-tenant lookups. The email check answers with the addresses in use and
-- nothing about whose they are; an approve link's person is found only together with a
-- request assigned to them, in their company.
DROP FUNCTION "public"."ooohm_emails_in_use"(text[]);--> statement-breakpoint
CREATE FUNCTION "public"."ooohm_emails_in_use"(p_emails text[])
RETURNS TABLE (email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT u.email FROM public."user" u WHERE u.email = ANY (p_emails)
$$;--> statement-breakpoint
DROP FUNCTION "public"."ooohm_link_person"(text);--> statement-breakpoint
CREATE FUNCTION "public"."ooohm_link_person"(p_user_id text, p_request_id uuid)
RETURNS TABLE (id text, company_id uuid, role public.role, can_self_approve boolean, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.company_id, u.role, u.can_self_approve, u.is_active
  FROM public."user" u
  JOIN public.leave_requests r ON r.approver_id = u.id AND r.company_id = u.company_id
  WHERE u.id = p_user_id AND r.id = p_request_id AND u.deleted_at IS NULL
$$;--> statement-breakpoint

-- 3. References between rows. A foreign key is checked past row security, so with one
-- company's tenant a row could name another company's person, leave type, department,
-- endpoint or event, and a write could tell whether an id exists. Each table's trigger
-- below refuses a reference that names no row of the row's own company, the same way for
-- another company's id and a missing one, before the foreign key is checked. It runs as
-- the owner (SECURITY DEFINER), so the answer never depends on what the tenant can see, and
-- only when a tenant is set: the owner's own work without one (migrations, the seed, the
-- TimeOff import) is not the app's. On UPDATE it checks only the columns that change, so a
-- row that already names someone who later moved company can still be edited. The audit
-- log may also name people of the company a transaction switched from (the acting company:
-- a person's revoke of their own calendar link from a company they left, recorded there).

-- The company a transaction switched from (src/db/tenant.ts, switchTenantWithin), or NULL.
CREATE FUNCTION "public"."ooohm_acting_company"() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.acting_company_id', true), '')::uuid
$$;--> statement-breakpoint


-- user: manager_id, department_id, level_id, scrub_requested_by
CREATE FUNCTION "public"."ooohm_user_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.manager_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.manager_id IS DISTINCT FROM OLD.manager_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.manager_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.department_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id)
     AND NOT EXISTS (SELECT 1 FROM public.departments p WHERE p.id = NEW.department_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.level_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.level_id IS DISTINCT FROM OLD.level_id)
     AND NOT EXISTS (SELECT 1 FROM public.levels p WHERE p.id = NEW.level_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.scrub_requested_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.scrub_requested_by IS DISTINCT FROM OLD.scrub_requested_by)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.scrub_requested_by AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "user_references" BEFORE INSERT OR UPDATE ON "public"."user"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_user_references"();--> statement-breakpoint

-- departments: manager_id
CREATE FUNCTION "public"."ooohm_departments_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.manager_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.manager_id IS DISTINCT FROM OLD.manager_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.manager_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "departments_references" BEFORE INSERT OR UPDATE ON "public"."departments"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_departments_references"();--> statement-breakpoint

-- allowance_rules: leave_type_id, department_id, level_id
CREATE FUNCTION "public"."ooohm_allowance_rules_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.leave_type_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.leave_type_id IS DISTINCT FROM OLD.leave_type_id)
     AND NOT EXISTS (SELECT 1 FROM public.leave_types p WHERE p.id = NEW.leave_type_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.department_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id)
     AND NOT EXISTS (SELECT 1 FROM public.departments p WHERE p.id = NEW.department_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.level_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.level_id IS DISTINCT FROM OLD.level_id)
     AND NOT EXISTS (SELECT 1 FROM public.levels p WHERE p.id = NEW.level_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "allowance_rules_references" BEFORE INSERT OR UPDATE ON "public"."allowance_rules"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_allowance_rules_references"();--> statement-breakpoint

-- leave_requests: user_id, leave_type_id, approver_id
CREATE FUNCTION "public"."ooohm_leave_requests_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.user_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.leave_type_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.leave_type_id IS DISTINCT FROM OLD.leave_type_id)
     AND NOT EXISTS (SELECT 1 FROM public.leave_types p WHERE p.id = NEW.leave_type_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.approver_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.approver_id IS DISTINCT FROM OLD.approver_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.approver_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "leave_requests_references" BEFORE INSERT OR UPDATE ON "public"."leave_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_leave_requests_references"();--> statement-breakpoint

-- calendar_feed_tokens: user_id
CREATE FUNCTION "public"."ooohm_calendar_feed_tokens_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.user_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "calendar_feed_tokens_references" BEFORE INSERT OR UPDATE ON "public"."calendar_feed_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_calendar_feed_tokens_references"();--> statement-breakpoint

-- audit_log: actor_id, actor_requested_by, subject_user_id, api_key_id
CREATE FUNCTION "public"."ooohm_audit_log_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.actor_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.actor_id IS DISTINCT FROM OLD.actor_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.actor_id AND (p.company_id = NEW.company_id OR p.company_id = public.ooohm_acting_company())) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.actor_requested_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.actor_requested_by IS DISTINCT FROM OLD.actor_requested_by)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.actor_requested_by AND (p.company_id = NEW.company_id OR p.company_id = public.ooohm_acting_company())) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.subject_user_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.subject_user_id AND (p.company_id = NEW.company_id OR p.company_id = public.ooohm_acting_company())) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.api_key_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.api_key_id IS DISTINCT FROM OLD.api_key_id)
     AND NOT EXISTS (SELECT 1 FROM public.api_keys p WHERE p.id = NEW.api_key_id AND (p.company_id = NEW.company_id OR p.company_id = public.ooohm_acting_company())) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_references" BEFORE INSERT OR UPDATE ON "public"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_audit_log_references"();--> statement-breakpoint

-- webhook_endpoints: created_by
CREATE FUNCTION "public"."ooohm_webhook_endpoints_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.created_by IS DISTINCT FROM OLD.created_by)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.created_by AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "webhook_endpoints_references" BEFORE INSERT OR UPDATE ON "public"."webhook_endpoints"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_webhook_endpoints_references"();--> statement-breakpoint

-- webhook_deliveries: endpoint_id
CREATE FUNCTION "public"."ooohm_webhook_deliveries_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.endpoint_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id)
     AND NOT EXISTS (SELECT 1 FROM public.webhook_endpoints p WHERE p.id = NEW.endpoint_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "webhook_deliveries_references" BEFORE INSERT OR UPDATE ON "public"."webhook_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_webhook_deliveries_references"();--> statement-breakpoint

-- adapter_deliveries: event_id
CREATE FUNCTION "public"."ooohm_adapter_deliveries_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.event_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.event_id IS DISTINCT FROM OLD.event_id)
     AND NOT EXISTS (SELECT 1 FROM public.events_outbox p WHERE p.id = NEW.event_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "adapter_deliveries_references" BEFORE INSERT OR UPDATE ON "public"."adapter_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_adapter_deliveries_references"();--> statement-breakpoint

-- api_keys: created_by
CREATE FUNCTION "public"."ooohm_api_keys_references"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.ooohm_tenant() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.created_by IS DISTINCT FROM OLD.created_by)
     AND NOT EXISTS (SELECT 1 FROM public."user" p WHERE p.id = NEW.created_by AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'A reference names no row of this company.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "api_keys_references" BEFORE INSERT OR UPDATE ON "public"."api_keys"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_api_keys_references"();--> statement-breakpoint

-- 4. Every outbox event names its company. Rows without one were never dispatched by the
-- per-company worker (before row security the dispatcher marked them dispatched without
-- deliveries) nor visible to any company; they go, then the column is required.
DELETE FROM "public"."events_outbox" WHERE "company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "events_outbox" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."ooohm_auth_person"(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_auth_session_company"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_auth_account_company"(text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_auth_passkey_company"(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_emails_in_use"(text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_link_person"(text, uuid) FROM PUBLIC;
