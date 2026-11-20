-- Perch feedback (feedback/src/index.js). One row per message sent from the website's feedback page.
-- Never stored: the sender's IP address, browser identity or cookies.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,             -- ISO 8601, UTC
  kind TEXT NOT NULL,                   -- idea | bug | other
  message TEXT NOT NULL,                -- at most 4000 characters
  contact TEXT,                         -- optional: how to reach them, as they typed it (at most 200 characters)
  os TEXT,                              -- optional: the system Perch was controlling (mac, windows, linux)
  version TEXT,                         -- optional: Perch's version, when sent from the viewer or Setup
  source TEXT NOT NULL,                 -- site | viewer | setup
  status TEXT NOT NULL DEFAULT 'new',   -- new | seen | approved | declined | done
  notes TEXT                            -- the owner's notes
);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback (status, created_at);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);
