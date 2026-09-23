ALTER TABLE requests ADD COLUMN attribution TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(attribution));
