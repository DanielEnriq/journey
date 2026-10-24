CREATE TABLE `claude_code_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`cwd` text,
	`git_branch` text,
	`title` text NOT NULL,
	`created_at` text,
	`last_modified_at` text NOT NULL,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `claude_code_sessions_repository` ON `claude_code_sessions` (`repository_id`,`last_modified_at`);--> statement-breakpoint
CREATE TABLE `workstreams` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`first_seen_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workstreams_worktree_branch` ON `workstreams` (`repository_id`,`worktree_path`,`branch`);