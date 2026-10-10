UPDATE `sessions`
SET `active_agent_provider` = CASE
  WHEN `pi_session_path` IS NOT NULL AND `pi_session_path` != '-1' THEN 'pi'
  WHEN `codex_session_id` IS NOT NULL AND `codex_session_id` != '-1' THEN 'codex'
  ELSE 'claude'
END
WHERE `active_agent_provider` = 'antigravity';
--> statement-breakpoint
UPDATE `app_settings`
SET `default_agent_provider` = 'claude'
WHERE `default_agent_provider` = 'antigravity';
--> statement-breakpoint
UPDATE `app_settings`
SET `default_model_by_provider` = json_remove(`default_model_by_provider`, '$.antigravity')
WHERE json_valid(`default_model_by_provider`);
--> statement-breakpoint
UPDATE `app_settings`
SET `default_reasoning_effort_by_provider` = json_remove(`default_reasoning_effort_by_provider`, '$.antigravity')
WHERE json_valid(`default_reasoning_effort_by_provider`);
--> statement-breakpoint
UPDATE `app_settings`
SET `agent_model_presets` = (
  SELECT json_group_array(json(value))
  FROM json_each(`app_settings`.`agent_model_presets`)
  WHERE json_extract(value, '$.provider') IS NOT 'antigravity'
)
WHERE json_valid(`agent_model_presets`) AND json_type(`agent_model_presets`) = 'array';
--> statement-breakpoint
UPDATE `app_settings`
SET `speech_to_text` = json_set(`speech_to_text`, '$.cleanupMode', 'off', '$.cleanupProvider', NULL, '$.cleanupModel', NULL)
WHERE json_valid(`speech_to_text`) AND json_extract(`speech_to_text`, '$.cleanupProvider') = 'antigravity';
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `antigravity_session_id`;
