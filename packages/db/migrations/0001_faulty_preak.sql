ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "payload" jsonb;