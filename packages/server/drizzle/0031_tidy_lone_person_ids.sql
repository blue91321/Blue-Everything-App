-- A person id shared by exactly one account is not a group.
--
-- Left behind when an errored Riot report emptied the friends snapshot: the
-- riot rows were pruned and re-inserted with new ids, and their Discord
-- partners kept a person id nothing else shared. Those rows render exactly
-- like unlinked ones, so the state was invisible while still being wrong —
-- the row offered "Unlink" for a link that no longer existed.
UPDATE `friends`
SET `person_id` = NULL
WHERE `person_id` IS NOT NULL
  AND `person_id` IN (
    SELECT `person_id` FROM `friends` WHERE `person_id` IS NOT NULL
    GROUP BY `person_id` HAVING COUNT(*) = 1
  );
