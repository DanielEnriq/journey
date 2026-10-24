CREATE TABLE `claude_code_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`cwd` text,
	`tool_name` text,
	`summary` text,
	`subagent` integer DEFAULT false NOT NULL,
	`received_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claude_code_events_session` ON `claude_code_events` (`session_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `claude_code_events_time` ON `claude_code_events` (`occurred_at`);