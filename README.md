# Discord Bot with PostgreSQL

A Discord bot that stores and manages conversations using PostgreSQL for data persistence, featuring a web admin dashboard.

## Features

- Discord direct message handling with complete message history
- Web dashboard for viewing and replying to conversations
- Proper timestamp handling in Pacific Standard Time (PST)
- PostgreSQL database for reliable message storage
- Admin authentication for dashboard security
- Railway deployment support

## Tech Stack

- Node.js
- Express.js
- Discord.js v14
- PostgreSQL (via Neon.tech)
- EJS templating engine

## Prerequisites

- Node.js 16+
- PostgreSQL database (recommend [Neon](https://neon.tech/))
- Discord Bot token with proper intents enabled

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```
DISCORD_TOKEN=your_discord_bot_token
ADMIN_PASSWORD=your_admin_password
SESSION_SECRET=your_random_session_secret
PORT=3000
DATABASE_URL=your_postgresql_connection_string
```

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/discord-bot.git
   cd discord-bot
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the application:
   ```
   npm start
   ```

## Database Schema

This project uses a PostgreSQL database with the following schema:

### Users Table

```sql
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  last_activity BIGINT, -- Timestamp in milliseconds (epoch time)
  last_message TEXT
);
```

### Messages Table

```sql
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL, -- Timestamp in milliseconds (epoch time)
  from_user BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Index for efficient querying
  CONSTRAINT user_message_timestamp UNIQUE(user_id, timestamp, content)
);
```

## Timestamp Handling

The application handles timestamps consistently throughout:

- All timestamps are stored as BIGINT in the database (milliseconds since epoch)
- Discord message timestamps are captured using message.createdTimestamp
- Timestamps are displayed in Pacific Standard Time (PST) format
- The dashboard shows formatted timestamps for better readability
- Invalid timestamps are automatically repaired during application startup

## Deployment

### Railway Deployment Instructions

1. Install the Railway CLI:
   ```
   npm install -g @railway/cli
   ```

2. Login to Railway:
   ```
   railway login
   ```
   Or for browserless environments:
   ```
   railway login --browserless
   ```

3. Link your project:
   ```
   railway link
   ```

4. Set your environment variables:
   ```
   railway variables set DISCORD_TOKEN=your_token ADMIN_PASSWORD=your_password ...
   ```

5. Deploy your application:
   ```
   railway up
   ```

6. Create a domain for your application:
   ```
   railway domain
   ```

7. Your web dashboard will be available at the provided domain URL.

## Development

The project structure:

- `index.js` - Main application entry point
- `database.js` - Database connection and operations
- `setup.sql` - Database schema creation script
- `health-check.js` - Health check endpoint for Railway
- `views/` - EJS templates for the web dashboard
- `backups/` - Backup of the original JSON data

## Troubleshooting

### Database Issues

- If you see "Invalid Date" errors, the application will automatically fix timestamp formats in the database
- The `fixTimestamps()` function runs on startup to correct any invalid timestamp data

### Deployment Issues

- **Port conflicts**: The application handles port conflicts gracefully by using the PORT environment variable
- **Discord connection**: Ensure your bot token has the proper intents enabled (Message Content, Server Members, etc.)
- **Web dashboard access**: Use the admin password defined in the ADMIN_PASSWORD environment variable

### Message Sending Issues

If messages aren't sending:
1. Check the Railway logs for specific error messages
2. Verify the Discord token has proper permissions
3. Ensure the bot can access DM channels
4. Confirm the timestamp format in the database is correct 