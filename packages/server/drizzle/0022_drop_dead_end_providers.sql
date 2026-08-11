DELETE FROM `integration_accounts` WHERE `id` IN ('battlenet', 'epic');--> statement-breakpoint
DELETE FROM `friends` WHERE `provider` IN ('battlenet', 'epic');--> statement-breakpoint
DELETE FROM `follows` WHERE `provider` IN ('battlenet', 'epic');
