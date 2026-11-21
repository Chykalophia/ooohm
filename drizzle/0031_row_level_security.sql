-- Row-level security on every company-scoped table (ADR-0004): defence in depth under the
-- `company_id` filter every repository query already has.
--
-- The tenant is the transaction-local setting `app.company_id`, which the app sets with
-- set_config('app.company_id', <id>, true) at the start of every transaction it runs for a
-- company (`src/db/tenant.ts`). Unset or empty, a tenant table shows no row and takes no
-- write (fail closed). Every table is ENABLEd and FORCEd, and has one policy per operation
-- for everyone plus one for its owner, who still sees and changes every row (migrations,
-- the seed, the TimeOff import, and the narrow SECURITY DEFINER functions below).
--
-- Tables without a tenant are left alone: installation, scheduled_jobs, verification
-- (sign-in tokens, keyed by email before anyone is known) and drizzle's journal.

-- The tenant of the current transaction, or NULL. Inlined by the planner.
CREATE OR REPLACE FUNCTION "public"."ooohm_tenant"() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;--> statement-breakpoint

-- Each table: ENABLE and FORCE, one policy per operation for everyone, and one for its
-- owner. Tables with their own company_id compare it (companies: its id) to the tenant;
-- the rest are scoped through their parent: a person's rows through "user", a request's
-- per-year days through leave_requests, and an allowance's leave type must be the
-- tenant's too.

-- companies
ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "companies_tenant_select" ON "public"."companies" AS PERMISSIVE FOR SELECT TO PUBLIC USING (id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "companies_tenant_insert" ON "public"."companies" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "companies_tenant_update" ON "public"."companies" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (id = public.ooohm_tenant()) WITH CHECK (id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "companies_tenant_delete" ON "public"."companies" AS PERMISSIVE FOR DELETE TO PUBLIC USING (id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "companies_owner" ON "public"."companies" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- departments
ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."departments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "departments_tenant_select" ON "public"."departments" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "departments_tenant_insert" ON "public"."departments" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "departments_tenant_update" ON "public"."departments" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "departments_tenant_delete" ON "public"."departments" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "departments_owner" ON "public"."departments" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- email_templates
ALTER TABLE "public"."email_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."email_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "email_templates_tenant_select" ON "public"."email_templates" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "email_templates_tenant_insert" ON "public"."email_templates" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "email_templates_tenant_update" ON "public"."email_templates" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "email_templates_tenant_delete" ON "public"."email_templates" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "email_templates_owner" ON "public"."email_templates" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- levels
ALTER TABLE "public"."levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."levels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "levels_tenant_select" ON "public"."levels" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "levels_tenant_insert" ON "public"."levels" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "levels_tenant_update" ON "public"."levels" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "levels_tenant_delete" ON "public"."levels" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "levels_owner" ON "public"."levels" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- user
ALTER TABLE "public"."user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_tenant_select" ON "public"."user" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "user_tenant_insert" ON "public"."user" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "user_tenant_update" ON "public"."user" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "user_tenant_delete" ON "public"."user" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "user_owner" ON "public"."user" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- leave_types
ALTER TABLE "public"."leave_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."leave_types" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "leave_types_tenant_select" ON "public"."leave_types" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_types_tenant_insert" ON "public"."leave_types" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_types_tenant_update" ON "public"."leave_types" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_types_tenant_delete" ON "public"."leave_types" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_types_owner" ON "public"."leave_types" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- allowance_rules
ALTER TABLE "public"."allowance_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."allowance_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "allowance_rules_tenant_select" ON "public"."allowance_rules" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "allowance_rules_tenant_insert" ON "public"."allowance_rules" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "allowance_rules_tenant_update" ON "public"."allowance_rules" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "allowance_rules_tenant_delete" ON "public"."allowance_rules" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "allowance_rules_owner" ON "public"."allowance_rules" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- holidays
ALTER TABLE "public"."holidays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."holidays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "holidays_tenant_select" ON "public"."holidays" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "holidays_tenant_insert" ON "public"."holidays" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "holidays_tenant_update" ON "public"."holidays" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "holidays_tenant_delete" ON "public"."holidays" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "holidays_owner" ON "public"."holidays" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- leave_requests
ALTER TABLE "public"."leave_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."leave_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "leave_requests_tenant_select" ON "public"."leave_requests" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_requests_tenant_insert" ON "public"."leave_requests" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_requests_tenant_update" ON "public"."leave_requests" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_requests_tenant_delete" ON "public"."leave_requests" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "leave_requests_owner" ON "public"."leave_requests" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- calendar_feed_tokens: the company's links, and its members' own links from a company
-- they have left (so they can see and turn off one that would work again if they moved
-- back). A member's link from elsewhere can only be revoked, never moved or revived.
ALTER TABLE "public"."calendar_feed_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."calendar_feed_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "calendar_feed_tokens_tenant_select" ON "public"."calendar_feed_tokens" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant() OR EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.calendar_feed_tokens.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "calendar_feed_tokens_tenant_insert" ON "public"."calendar_feed_tokens" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "calendar_feed_tokens_tenant_update" ON "public"."calendar_feed_tokens" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant() OR EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.calendar_feed_tokens.user_id AND u.company_id = public.ooohm_tenant())) WITH CHECK (company_id = public.ooohm_tenant() OR (revoked_at IS NOT NULL AND EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.calendar_feed_tokens.user_id AND u.company_id = public.ooohm_tenant())));--> statement-breakpoint
CREATE POLICY "calendar_feed_tokens_tenant_delete" ON "public"."calendar_feed_tokens" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "calendar_feed_tokens_owner" ON "public"."calendar_feed_tokens" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- A link stays in the company it was issued in, so a member's link from elsewhere can be
-- revoked from their new company but never moved into it (which would revive it).
CREATE FUNCTION "public"."ooohm_calendar_feed_company_fixed"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'A calendar link stays in the company it was issued in.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "calendar_feed_tokens_company_fixed" BEFORE UPDATE OF company_id ON "public"."calendar_feed_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."ooohm_calendar_feed_company_fixed"();--> statement-breakpoint

-- audit_log
ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_tenant_select" ON "public"."audit_log" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "audit_log_tenant_insert" ON "public"."audit_log" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "audit_log_tenant_update" ON "public"."audit_log" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "audit_log_tenant_delete" ON "public"."audit_log" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "audit_log_owner" ON "public"."audit_log" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- events_outbox
ALTER TABLE "public"."events_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."events_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "events_outbox_tenant_select" ON "public"."events_outbox" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "events_outbox_tenant_insert" ON "public"."events_outbox" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "events_outbox_tenant_update" ON "public"."events_outbox" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "events_outbox_tenant_delete" ON "public"."events_outbox" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "events_outbox_owner" ON "public"."events_outbox" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- webhook_endpoints
ALTER TABLE "public"."webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_select" ON "public"."webhook_endpoints" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_insert" ON "public"."webhook_endpoints" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_update" ON "public"."webhook_endpoints" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_delete" ON "public"."webhook_endpoints" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_endpoints_owner" ON "public"."webhook_endpoints" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- webhook_deliveries
ALTER TABLE "public"."webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_select" ON "public"."webhook_deliveries" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_insert" ON "public"."webhook_deliveries" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_update" ON "public"."webhook_deliveries" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_delete" ON "public"."webhook_deliveries" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "webhook_deliveries_owner" ON "public"."webhook_deliveries" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- adapter_deliveries
ALTER TABLE "public"."adapter_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."adapter_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "adapter_deliveries_tenant_select" ON "public"."adapter_deliveries" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "adapter_deliveries_tenant_insert" ON "public"."adapter_deliveries" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "adapter_deliveries_tenant_update" ON "public"."adapter_deliveries" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "adapter_deliveries_tenant_delete" ON "public"."adapter_deliveries" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "adapter_deliveries_owner" ON "public"."adapter_deliveries" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- api_keys
ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "api_keys_tenant_select" ON "public"."api_keys" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "api_keys_tenant_insert" ON "public"."api_keys" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "api_keys_tenant_update" ON "public"."api_keys" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "api_keys_tenant_delete" ON "public"."api_keys" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "api_keys_owner" ON "public"."api_keys" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- import_runs
ALTER TABLE "public"."import_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."import_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "import_runs_tenant_select" ON "public"."import_runs" AS PERMISSIVE FOR SELECT TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "import_runs_tenant_insert" ON "public"."import_runs" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "import_runs_tenant_update" ON "public"."import_runs" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (company_id = public.ooohm_tenant()) WITH CHECK (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "import_runs_tenant_delete" ON "public"."import_runs" AS PERMISSIVE FOR DELETE TO PUBLIC USING (company_id = public.ooohm_tenant());--> statement-breakpoint
CREATE POLICY "import_runs_owner" ON "public"."import_runs" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- allowances
ALTER TABLE "public"."allowances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."allowances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "allowances_tenant_select" ON "public"."allowances" AS PERMISSIVE FOR SELECT TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.allowances.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "allowances_tenant_insert" ON "public"."allowances" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.allowances.user_id AND u.company_id = public.ooohm_tenant()) AND EXISTS (SELECT 1 FROM public.leave_types lt WHERE lt.id = public.allowances.leave_type_id AND lt.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "allowances_tenant_update" ON "public"."allowances" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.allowances.user_id AND u.company_id = public.ooohm_tenant())) WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.allowances.user_id AND u.company_id = public.ooohm_tenant()) AND EXISTS (SELECT 1 FROM public.leave_types lt WHERE lt.id = public.allowances.leave_type_id AND lt.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "allowances_tenant_delete" ON "public"."allowances" AS PERMISSIVE FOR DELETE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.allowances.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "allowances_owner" ON "public"."allowances" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- leave_request_days
ALTER TABLE "public"."leave_request_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."leave_request_days" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "leave_request_days_tenant_select" ON "public"."leave_request_days" AS PERMISSIVE FOR SELECT TO PUBLIC USING (EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.id = public.leave_request_days.request_id AND r.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "leave_request_days_tenant_insert" ON "public"."leave_request_days" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.id = public.leave_request_days.request_id AND r.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "leave_request_days_tenant_update" ON "public"."leave_request_days" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.id = public.leave_request_days.request_id AND r.company_id = public.ooohm_tenant())) WITH CHECK (EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.id = public.leave_request_days.request_id AND r.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "leave_request_days_tenant_delete" ON "public"."leave_request_days" AS PERMISSIVE FOR DELETE TO PUBLIC USING (EXISTS (SELECT 1 FROM public.leave_requests r WHERE r.id = public.leave_request_days.request_id AND r.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "leave_request_days_owner" ON "public"."leave_request_days" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- session
ALTER TABLE "public"."session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "session_tenant_select" ON "public"."session" AS PERMISSIVE FOR SELECT TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.session.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "session_tenant_insert" ON "public"."session" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.session.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "session_tenant_update" ON "public"."session" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.session.user_id AND u.company_id = public.ooohm_tenant())) WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.session.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "session_tenant_delete" ON "public"."session" AS PERMISSIVE FOR DELETE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.session.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "session_owner" ON "public"."session" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- account
ALTER TABLE "public"."account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "account_tenant_select" ON "public"."account" AS PERMISSIVE FOR SELECT TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.account.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "account_tenant_insert" ON "public"."account" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.account.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "account_tenant_update" ON "public"."account" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.account.user_id AND u.company_id = public.ooohm_tenant())) WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.account.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "account_tenant_delete" ON "public"."account" AS PERMISSIVE FOR DELETE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.account.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "account_owner" ON "public"."account" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- passkey
ALTER TABLE "public"."passkey" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."passkey" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "passkey_tenant_select" ON "public"."passkey" AS PERMISSIVE FOR SELECT TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.passkey.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "passkey_tenant_insert" ON "public"."passkey" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.passkey.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "passkey_tenant_update" ON "public"."passkey" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.passkey.user_id AND u.company_id = public.ooohm_tenant())) WITH CHECK (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.passkey.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "passkey_tenant_delete" ON "public"."passkey" AS PERMISSIVE FOR DELETE TO PUBLIC USING (EXISTS (SELECT 1 FROM public."user" u WHERE u.id = public.passkey.user_id AND u.company_id = public.ooohm_tenant()));--> statement-breakpoint
CREATE POLICY "passkey_owner" ON "public"."passkey" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint

-- Better Auth's tables, as Better Auth sees them: it signs people in before any company
-- is known (a user by email, a session by token, an account, a passkey). Owned by the
-- owner, so they read through its policy; only src/lib/auth.ts uses them
-- (tests/architecture/row-level-security.test.ts). The user view leaves out what sign-in
-- never needs (deletion, scrub and level columns).
CREATE VIEW "public"."auth_user" WITH (security_barrier) AS
  SELECT id, name, email, email_verified, image, created_at, updated_at, company_id, department_id, manager_id,
         role, can_self_approve, is_active, theme
  FROM public."user";--> statement-breakpoint
CREATE VIEW "public"."auth_session" WITH (security_barrier) AS
  SELECT id, expires_at, token, ip_address, user_agent, user_id, created_at, updated_at FROM public.session;--> statement-breakpoint
CREATE VIEW "public"."auth_account" WITH (security_barrier) AS
  SELECT id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at,
         refresh_token_expires_at, scope, password, created_at, updated_at
  FROM public.account;--> statement-breakpoint
CREATE VIEW "public"."auth_passkey" WITH (security_barrier) AS
  SELECT id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, created_at, aaguid
  FROM public.passkey;--> statement-breakpoint

-- The pre-tenant lookups: the few reads that find a company before one is known, each
-- keyed by a secret or naming only what its caller needs. SECURITY DEFINER (they read as
-- the owner), search_path pinned, EXECUTE for the app role only (deploy/db-roles.sql).
-- The list is pinned by tests/architecture/row-level-security.test.ts.

-- REST API authentication: the live key with this SHA-256.
CREATE FUNCTION "public"."ooohm_api_key_for_hash"(p_key_hash text)
RETURNS TABLE (id uuid, company_id uuid, key_hash text, scopes text[], last_used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.id, k.company_id, k.key_hash, k.scopes, k.last_used_at
  FROM public.api_keys k
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
$$;--> statement-breakpoint

-- Calendar feeds: the live feed with this token SHA-256, its active owner and what the feed shows.
CREATE FUNCTION "public"."ooohm_calendar_feed_for_hash"(p_token_hash text)
RETURNS TABLE (
  id uuid, user_id text, company_id uuid, kind public.calendar_feed_kind, last_used_at timestamptz, company_name text,
  timezone text, owner_role public.role, owner_manager_id text, owner_department_id uuid, colleague_visibility text,
  department_scoping boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT f.id, f.user_id, f.company_id, f.kind, f.last_used_at, c.name, c.timezone, u.role, u.manager_id, u.department_id,
         c.colleague_visibility, c.department_scoping
  FROM public.calendar_feed_tokens f
  JOIN public."user" u ON u.id = f.user_id
  JOIN public.companies c ON c.id = f.company_id
  WHERE f.token_hash = p_token_hash AND f.revoked_at IS NULL AND u.is_active AND u.company_id = f.company_id
$$;--> statement-breakpoint

-- Approve links: the person a signed link names, as an actor (a deleted person reads as missing).
CREATE FUNCTION "public"."ooohm_link_person"(p_user_id text)
RETURNS TABLE (id text, company_id uuid, role public.role, can_self_approve boolean, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.company_id, u.role, u.can_self_approve, u.is_active
  FROM public."user" u
  WHERE u.id = p_user_id AND u.deleted_at IS NULL
$$;--> statement-breakpoint

-- Pages that render before anyone is known (sign-in, the favicon): the deployment
-- company's (the oldest) name, look and logo description.
CREATE FUNCTION "public"."ooohm_deployment_brand"()
RETURNS TABLE (
  name text, theme text, accent_color text, corners text, request_style text, layout text, logo_sha256 text,
  logo_type text, logo_width integer, logo_height integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.name, c.theme, c.accent_color, c.corners, c.request_style, c.layout, c.logo_sha256, c.logo_type, c.logo_width,
         c.logo_height
  FROM public.companies c
  ORDER BY c.created_at, c.id
  LIMIT 1
$$;--> statement-breakpoint

-- /logo/<sha256>.<ext>: a stored logo by the SHA-256 that names it (public, like the favicon).
CREATE FUNCTION "public"."ooohm_logo_file"(p_sha256 text)
RETURNS TABLE (bytes bytea, content_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.logo, c.logo_type FROM public.companies c WHERE c.logo_sha256 = p_sha256 LIMIT 1
$$;--> statement-breakpoint

-- The jobs that loop over companies (the year rollover, retention): each company's id and
-- the settings the loop plans with. The work itself runs in each company's own transaction.
CREATE FUNCTION "public"."ooohm_companies"()
RETURNS TABLE (id uuid, timezone text, working_days integer[], allowance_policy text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.timezone, c.working_days, c.allowance_policy FROM public.companies c ORDER BY c.created_at, c.id
$$;--> statement-breakpoint

-- The outbox worker: which companies hold the oldest `p_limit` undispatched events, and how many each.
CREATE FUNCTION "public"."ooohm_undispatched_event_companies"(p_limit integer)
RETURNS TABLE (company_id uuid, events integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.company_id, count(*)::integer
  FROM (
    SELECT e.company_id, e.created_at FROM public.events_outbox e
    WHERE e.delivered_at IS NULL AND e.company_id IS NOT NULL
    ORDER BY e.created_at, e.id
    LIMIT p_limit
  ) o
  GROUP BY o.company_id
  ORDER BY min(o.created_at)
$$;--> statement-breakpoint

-- Which companies hold the first `p_limit` webhook deliveries due at `p_now`, and how many each.
CREATE FUNCTION "public"."ooohm_due_webhook_companies"(p_now timestamptz, p_limit integer)
RETURNS TABLE (company_id uuid, deliveries integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.company_id, count(*)::integer
  FROM (
    SELECT d2.company_id, d2.next_attempt_at FROM public.webhook_deliveries d2
    JOIN public.webhook_endpoints e2 ON e2.id = d2.endpoint_id
    WHERE d2.status = 'pending' AND d2.next_attempt_at <= p_now AND e2.enabled AND e2.deleted_at IS NULL
    ORDER BY d2.next_attempt_at, d2.id
    LIMIT p_limit
  ) d
  GROUP BY d.company_id
  ORDER BY min(d.next_attempt_at)
$$;--> statement-breakpoint

-- Which companies hold the first `p_limit` adapter deliveries due at `p_now`, and how many each.
CREATE FUNCTION "public"."ooohm_due_adapter_companies"(p_now timestamptz, p_limit integer)
RETURNS TABLE (company_id uuid, deliveries integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.company_id, count(*)::integer
  FROM (
    SELECT d2.company_id, d2.next_attempt_at FROM public.adapter_deliveries d2
    WHERE d2.status = 'pending' AND d2.next_attempt_at <= p_now
    ORDER BY d2.next_attempt_at, d2.id
    LIMIT p_limit
  ) d
  GROUP BY d.company_id
  ORDER BY min(d.next_attempt_at)
$$;--> statement-breakpoint

-- Of `p_emails` (lowercased, as stored), those an account in any company uses, and its
-- company: an address belongs to one account, so an invite, a people import or a sync
-- must see the ones taken elsewhere. Nothing else of the account.
CREATE FUNCTION "public"."ooohm_emails_in_use"(p_emails text[])
RETURNS TABLE (email text, company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.email, u.company_id FROM public."user" u WHERE u.email = ANY (p_emails)
$$;--> statement-breakpoint

-- Whether any company or person exists: the web setup stays closed on a database seeded
-- before the install marker existed.
CREATE FUNCTION "public"."ooohm_is_populated"()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.companies) OR EXISTS (SELECT 1 FROM public."user")
$$;--> statement-breakpoint

-- The scheduled-scrub job: full scrubs due at `p_now`, oldest first, after a cursor. Ids only.
CREATE FUNCTION "public"."ooohm_due_scrubs"(p_now timestamptz, p_limit integer, p_after_at timestamptz, p_after_id text)
RETURNS TABLE (id text, company_id uuid, scrub_scheduled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.company_id, u.scrub_scheduled_at
  FROM public."user" u
  WHERE u.scrub_scheduled_at IS NOT NULL AND u.scrub_scheduled_at <= p_now AND u.deleted_at IS NULL
    AND (p_after_at IS NULL OR (u.scrub_scheduled_at, u.id) > (p_after_at, p_after_id))
  ORDER BY u.scrub_scheduled_at, u.id
  LIMIT p_limit
$$;--> statement-breakpoint

-- The audit erasure functions (migration 0030) act only inside the caller's tenant.
CREATE OR REPLACE FUNCTION "public"."ooohm_erase_audit_about"(p_company_id uuid, p_user_id text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH erased AS (
    DELETE FROM public.audit_log
    WHERE company_id = p_company_id AND company_id = public.ooohm_tenant()
      AND (subject_user_id = p_user_id OR (entity_type = 'user' AND entity_id = p_user_id))
    RETURNING 1
  )
  SELECT count(*)::integer FROM erased;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."ooohm_redact_audit_snapshots"(p_id uuid, p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.audit_log SET before = p_before, after = p_after WHERE id = p_id AND company_id = public.ooohm_tenant();
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."ooohm_api_key_for_hash"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_calendar_feed_for_hash"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_link_person"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_deployment_brand"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_logo_file"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_companies"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_undispatched_event_companies"(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_due_webhook_companies"(timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_due_adapter_companies"(timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_due_scrubs"(timestamptz, integer, timestamptz, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_emails_in_use"(text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."ooohm_is_populated"() FROM PUBLIC;
