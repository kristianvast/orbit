CREATE TABLE farm_code_blobs (
  farm_id uuid NOT NULL,
  hash text NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (farm_id, hash)
);
--> statement-breakpoint
CREATE TABLE farm_code_commits (
  farm_id uuid NOT NULL,
  id text NOT NULL,
  parent text,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, id)
);
--> statement-breakpoint
CREATE TABLE farm_code_heads (
  farm_id uuid PRIMARY KEY,
  commit_id text
);
