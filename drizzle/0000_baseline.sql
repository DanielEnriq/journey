-- Hand-edited: IF NOT EXISTS so databases created before Drizzle (PRAGMA user_version = 1,
-- same two tables) adopt this baseline without error. Keep later migrations as generated.
CREATE TABLE IF NOT EXISTS `sessions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`refresh_token` blob NOT NULL,
	`scope` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`picture` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_login` text DEFAULT (datetime('now')) NOT NULL
);
