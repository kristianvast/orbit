CREATE TABLE chat_sessions (
  farm_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  parent_session_id uuid,
  header jsonb,
  deleted_at timestamptz,
  PRIMARY KEY (farm_id, user_id, id)
);
--> statement-breakpoint
CREATE TABLE chat_entries (
  seq bigserial UNIQUE NOT NULL,
  farm_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  id text NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (farm_id, user_id, session_id, id),
  FOREIGN KEY (farm_id, user_id, session_id) REFERENCES chat_sessions(farm_id, user_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX chat_entries_session_seq ON chat_entries(farm_id, user_id, session_id, seq);
