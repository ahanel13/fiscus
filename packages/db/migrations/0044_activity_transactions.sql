CREATE TABLE "activity_transactions" (
	"household_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "activity_transactions_household_id_transaction_id_seq_pk" PRIMARY KEY("household_id","transaction_id","seq")
);
