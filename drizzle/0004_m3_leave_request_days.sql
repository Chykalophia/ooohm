CREATE TABLE "leave_request_days" (
	"request_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"days" numeric(5, 1) NOT NULL,
	CONSTRAINT "leave_request_days_request_id_year_pk" PRIMARY KEY("request_id","year"),
	CONSTRAINT "leave_request_days_days_positive" CHECK ("leave_request_days"."days" > 0)
);
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_request_id_leave_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Backfill: a request inside one calendar year costs its stored total in that year.
INSERT INTO "leave_request_days" ("request_id", "year", "days")
SELECT "id", extract(year FROM "start_date")::int, "days"
FROM "leave_requests"
WHERE extract(year FROM "start_date") = extract(year FROM "end_date");
--> statement-breakpoint
-- Backfill: a request over New Year (at most 366 days, so at most two years) puts the
-- working days counted today up to Dec 31 in the first year, capped at the stored
-- total, and the rest of the stored total in the second. The rows always add up to
-- leave_requests.days, even if holidays changed since the request was submitted.
WITH "spanning" AS (
	SELECT
		lr."id",
		lr."days",
		extract(year FROM lr."start_date")::int AS "first_year",
		least(lr."days", (
			SELECT count(*)
			FROM generate_series(
				lr."start_date"::timestamp,
				make_date(extract(year FROM lr."start_date")::int, 12, 31)::timestamp,
				interval '1 day'
			) AS d("day")
			WHERE extract(isodow FROM d."day")::int = ANY (c."working_days")
				AND NOT EXISTS (
					SELECT 1 FROM "holidays" h WHERE h."company_id" = lr."company_id" AND h."date" = d."day"::date
				)
		)) AS "first_days"
	FROM "leave_requests" lr
	JOIN "companies" c ON c."id" = lr."company_id"
	WHERE extract(year FROM lr."start_date") <> extract(year FROM lr."end_date")
)
INSERT INTO "leave_request_days" ("request_id", "year", "days")
SELECT "id", "first_year", "first_days" FROM "spanning" WHERE "first_days" > 0
UNION ALL
SELECT "id", "first_year" + 1, "days" - "first_days" FROM "spanning" WHERE "days" - "first_days" > 0;
