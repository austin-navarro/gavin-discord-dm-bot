# Discord Bot with PostgreSQL

A Discord bot that stores and manages conversations using PostgreSQL for data persistence.

## Features

- Discord direct message handling
- Web dashboard for managing conversations
- PostgreSQL database for message storage
- Admin authentication for the dashboard

## Tech Stack

- Node.js
- Express.js
- Discord.js
- PostgreSQL (via Neon.tech)
- EJS templating engine

## Prerequisites

- Node.js 16+
- PostgreSQL database (we recommend [Neon](https://neon.tech/))
- Discord Bot token

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
  last_activity BIGINT,
  last_message TEXT
);
```

### Messages Table

```sql
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  from_user BOOLEAN NOT NULL DEFAULT FALSE
);
```

## Deployment

For production deployment, we recommend:

1. Hosting the bot on a service like Heroku, Railway, or Render
2. Using Neon.tech for PostgreSQL hosting
3. Setting up proper environment variables in your hosting platform

### Railway Deployment Instructions

1. Create a Railway account at [railway.app](https://railway.app)

2. Click "New Project" and select "Deploy from GitHub repo"

3. Connect your GitHub repository

4. Add the following environment variables in the Railway dashboard:
   - `DISCORD_TOKEN` - Your Discord bot token
   - `ADMIN_PASSWORD` - Password for admin dashboard access
   - `SESSION_SECRET` - A long random string for session security
   - `DATABASE_URL` - Your Neon PostgreSQL connection string

5. Railway will automatically deploy your app with the start command from package.json

6. Once deployed, you can access your web dashboard at the URL provided by Railway

7. If you encounter a TokenInvalid error, verify your DISCORD_TOKEN is correct in Railway environment variables

8. To debug, check the logs in the Railway dashboard

## Development

The project structure:

- `index.js` - Main application entry point
- `database.js` - Database connection and operations
- `views/` - EJS templates for the web dashboard
- `backups/` - Backup of the original JSON data

## Troubleshooting

If you encounter connection issues:

1. Verify your PostgreSQL connection string in `.env`
2. Check that your database is accessible from your hosting environment
3. Ensure your Discord bot token is valid
4. Check the console logs for specific error messages 