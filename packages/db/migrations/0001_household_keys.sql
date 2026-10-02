CREATE TABLE "household_keys" (
	"household_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"master_key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "household_keys_household_id_version_pk" PRIMARY KEY("household_id","version")
);
