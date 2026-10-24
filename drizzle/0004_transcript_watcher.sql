CREATE TABLE `claude_code_transcripts` (
	`path` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`offset` integer NOT NULL,
	`inode` integer,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `claude_code_events` ADD `source` text DEFAULT 'hook' NOT NULL;--> statement-breakpoint
ALTER TABLE `claude_code_events` ADD `file_path` text;