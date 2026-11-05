-- 实体名归一化：加 key（小写 + 压空白 + 去首尾符号），并把已有的重复节点合并掉
ALTER TABLE "kg_nodes" ADD COLUMN "key" text;--> statement-breakpoint
UPDATE "kg_nodes" SET "key" = btrim(regexp_replace(lower("name"), 's+', ' ', 'g'), ' ._-');--> statement-breakpoint
-- 同 key 的重复节点：先把边改指到最早的那个
WITH keep AS (
  SELECT DISTINCT ON ("user_id", "key") "id", "user_id", "key"
  FROM "kg_nodes" WHERE "key" IS NOT NULL
  ORDER BY "user_id", "key", "created_at", "id"
)
UPDATE "kg_edges" e SET "from_id" = k."id"
FROM "kg_nodes" n JOIN keep k ON k."user_id" = n."user_id" AND k."key" = n."key"
WHERE e."from_id" = n."id" AND n."id" <> k."id";--> statement-breakpoint
WITH keep AS (
  SELECT DISTINCT ON ("user_id", "key") "id", "user_id", "key"
  FROM "kg_nodes" WHERE "key" IS NOT NULL
  ORDER BY "user_id", "key", "created_at", "id"
)
UPDATE "kg_edges" e SET "to_id" = k."id"
FROM "kg_nodes" n JOIN keep k ON k."user_id" = n."user_id" AND k."key" = n."key"
WHERE e."to_id" = n."id" AND n."id" <> k."id";--> statement-breakpoint
DELETE FROM "kg_nodes" n USING "kg_nodes" m
WHERE n."user_id" = m."user_id" AND n."key" = m."key" AND n."id" <> m."id"
  AND (n."created_at", n."id") > (m."created_at", m."id");--> statement-breakpoint
ALTER TABLE "kg_nodes" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "kg_nodes_user_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "kg_nodes_user_key_uq" ON "kg_nodes" USING btree ("user_id","key");
