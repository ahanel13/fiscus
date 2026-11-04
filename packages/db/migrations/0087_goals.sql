CREATE TYPE "public"."goal_claim_reason" AS ENUM('earmarked', 'changed', 'released', 'gave_way', 'ended');--> statement-breakpoint
CREATE TYPE "public"."goal_kind" AS ENUM('save', 'pay_down');--> statement-breakpoint
CREATE TABLE "goal_claim_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reason" "goal_claim_reason" NOT NULL,
	"member_id" uuid,
	"amount_before_minor" bigint,
	"amount_after_minor" bigint,
	"percent_before_bps" integer,
	"percent_after_bps" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint,
	"percent_bps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_claims_goal_account" UNIQUE("goal_id","account_id"),
	CONSTRAINT "goal_claims_one_kind" CHECK (("goal_claims"."amount_minor" IS NULL) <> ("goal_claims"."percent_bps" IS NULL)),
	CONSTRAINT "goal_claims_amount" CHECK ("goal_claims"."amount_minor" IS NULL OR "goal_claims"."amount_minor" > 0),
	CONSTRAINT "goal_claims_percent" CHECK ("goal_claims"."percent_bps" IS NULL OR "goal_claims"."percent_bps" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" "goal_kind" DEFAULT 'save' NOT NULL,
	"name" text NOT NULL,
	"target_minor" bigint NOT NULL,
	"target_date" date,
	"plan_minor" bigint,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "goals_name" CHECK (length(btrim("goals"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "goals_target" CHECK ("goals"."target_minor" > 0),
	CONSTRAINT "goals_plan" CHECK ("goals"."plan_minor" IS NULL OR "goals"."plan_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goal_claim_events" ADD CONSTRAINT "goal_claim_events_household_id_goal_id_goals_household_id_id_fk" FOREIGN KEY ("household_id","goal_id") REFERENCES "public"."goals"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_claims" ADD CONSTRAINT "goal_claims_household_id_goal_id_goals_household_id_id_fk" FOREIGN KEY ("household_id","goal_id") REFERENCES "public"."goals"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_claims" ADD CONSTRAINT "goal_claims_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_claim_events_goal_id_at_index" ON "goal_claim_events" USING btree ("goal_id","at");--> statement-breakpoint
CREATE INDEX "goal_claims_account_id_index" ON "goal_claims" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "goals_household_id_index" ON "goals" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "goals_member_id_index" ON "goals" USING btree ("member_id");