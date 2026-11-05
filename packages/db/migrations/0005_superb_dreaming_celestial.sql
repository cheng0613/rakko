-- 语义检索需要 pgvector；镜像已换成 pgvector/pgvector:pg17
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "kg_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kg_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'concept' NOT NULL,
	"memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_from_id_kg_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."kg_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_to_id_kg_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."kg_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kg_edges_triple_uq" ON "kg_edges" USING btree ("user_id","from_id","to_id","relation");--> statement-breakpoint
CREATE INDEX "kg_edges_from_idx" ON "kg_edges" USING btree ("from_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kg_nodes_user_name_uq" ON "kg_nodes" USING btree ("user_id","name");