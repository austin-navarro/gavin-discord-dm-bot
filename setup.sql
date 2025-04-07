-- Users table to store user information
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  last_activity BIGINT, -- Explicitly using BIGINT for timestamp (milliseconds since epoch)
  last_message TEXT
);

-- Messages table to store conversation messages
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL, -- Explicitly using BIGINT for timestamp (milliseconds since epoch)
  from_user BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Index for efficient querying
  CONSTRAINT user_message_timestamp UNIQUE(user_id, timestamp, content)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_users_last_activity ON users(last_activity DESC); 