DROP INDEX "departments_company_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "departments_company_lower_name_uq" ON "departments" USING btree ("company_id",lower("name"));