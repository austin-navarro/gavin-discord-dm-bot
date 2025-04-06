require('dotenv').config();
const { Pool } = require('pg');

// Create a pool to manage connections
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// Users table operations
const userOperations = {
  // Get all users
  getAllUsers: async () => {
    try {
      const result = await pool.query('SELECT * FROM users ORDER BY last_activity DESC');
      return result.rows;
    } catch (error) {
      console.error('Error getting all users:', error);
      throw error;
    }
  },

  // Get user by ID
  getUserById: async (userId) => {
    try {
      const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      return result.rows[0];
    } catch (error) {
      console.error(`Error getting user ${userId}:`, error);
      throw error;
    }
  },

  // Insert or update user
  upsertUser: async (userId, username, lastActivity, lastMessage) => {
    try {
      const result = await pool.query(
        `INSERT INTO users (user_id, username, last_activity, last_message)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE
         SET username = EXCLUDED.username,
             last_activity = EXCLUDED.last_activity,
             last_message = EXCLUDED.last_message
         RETURNING *`,
        [userId, username, lastActivity, lastMessage]
      );
      return result.rows[0];
    } catch (error) {
      console.error(`Error upserting user ${userId}:`, error);
      throw error;
    }
  }
};

// Messages table operations
const messageOperations = {
  // Get messages for a user
  getMessagesByUserId: async (userId) => {
    try {
      const result = await pool.query(
        `SELECT * FROM messages 
         WHERE user_id = $1 
         ORDER BY timestamp ASC`,
        [userId]
      );
      return result.rows;
    } catch (error) {
      console.error(`Error getting messages for user ${userId}:`, error);
      throw error;
    }
  },

  // Insert a new message
  insertMessage: async (userId, content, timestamp, fromUser) => {
    try {
      const result = await pool.query(
        `INSERT INTO messages (user_id, content, timestamp, from_user)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, content, timestamp, fromUser]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Error inserting message:', error);
      throw error;
    }
  }
};

// Conversation operations - combining user and messages
const conversationOperations = {
  // Get all conversations with their last message
  getAllConversations: async () => {
    try {
      const users = await userOperations.getAllUsers();
      return users;
    } catch (error) {
      console.error('Error getting all conversations:', error);
      throw error;
    }
  },

  // Get a full conversation by user ID
  getConversationByUserId: async (userId) => {
    try {
      const user = await userOperations.getUserById(userId);
      if (!user) return null;
      
      const messages = await messageOperations.getMessagesByUserId(userId);
      
      return {
        userId: user.user_id,
        username: user.username,
        lastActivity: user.last_activity,
        lastMessage: user.last_message,
        messages: messages.map(msg => ({
          content: msg.content,
          timestamp: msg.timestamp,
          fromUser: msg.from_user
        }))
      };
    } catch (error) {
      console.error(`Error getting conversation for user ${userId}:`, error);
      throw error;
    }
  },

  // Add message to conversation
  addMessageToConversation: async (userId, username, content, timestamp, fromUser) => {
    try {
      // First update or insert the user
      await userOperations.upsertUser(userId, username, timestamp, content);
      
      // Then insert the message
      await messageOperations.insertMessage(userId, content, timestamp, fromUser);
      
      return true;
    } catch (error) {
      console.error(`Error adding message to conversation for user ${userId}:`, error);
      throw error;
    }
  },

  // Migration: Convert JSON conversations to database
  migrateJsonToDatabase: async (conversations) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const [userId, conversation] of Object.entries(conversations)) {
        // Insert user
        await client.query(
          `INSERT INTO users (user_id, username, last_activity, last_message)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO UPDATE
           SET username = EXCLUDED.username,
               last_activity = EXCLUDED.last_activity,
               last_message = EXCLUDED.last_message`,
          [userId, conversation.username, conversation.lastActivity, conversation.lastMessage]
        );
        
        // Insert messages
        for (const message of conversation.messages) {
          await client.query(
            `INSERT INTO messages (user_id, content, timestamp, from_user)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`, // Assumes no natural primary key other than id
            [userId, message.content, message.timestamp, message.fromUser]
          );
        }
      }
      
      await client.query('COMMIT');
      console.log(`✅ Migrated ${Object.keys(conversations).length} conversations to database`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error migrating conversations to database:', error);
      throw error;
    } finally {
      client.release();
    }
  }
};

module.exports = {
  pool,
  userOperations,
  messageOperations,
  conversationOperations
}; 