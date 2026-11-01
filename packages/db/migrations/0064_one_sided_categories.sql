-- Transfer categories that never have another side (a brokerage's Buy and Sell): detection and the
-- transfer review leave them alone. Additive: the previous release ignores the column.
ALTER TABLE "categories" ADD COLUMN "one_sided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Ones an import already made (Monarch's Buy, Sell, Balance Adjustments) start one-sided, so the
-- review stops asking for their other side. A switch in Settings → Categories turns it off.
UPDATE "categories" SET "one_sided" = true
FROM "category_groups" g
WHERE g."id" = "categories"."group_id" AND g."kind" = 'transfer'
  AND lower(btrim("categories"."name")) IN ('buy', 'sell', 'balance adjustments');
