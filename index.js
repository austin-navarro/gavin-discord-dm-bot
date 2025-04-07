require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const { conversationOperations, pool } = require('./database');

// Express app setup
const app = express();
const port = process.env.PORT || 3000;

// Add health check route for Railway
require('./health-check')(app);

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD,
  resave: false,
  saveUninitialized: false
}));

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Root route redirect to login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Store DM channels for replying
const dmChannels = new Map();

// Store conversations with timestamps (in-memory cache)
const conversations = new Map();

// Interface channel for admin messages
let INTERFACE_CHANNEL_ID = '';

// Debug mode
const DEBUG_MODE = true;

// Stats tracking
let stats = {
  totalUsers: 0,
  messagesTotal: 0,
  serverCount: 0
};

// Message history
let messageHistory = [];

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session.isAuthenticated) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Debug function to log conversation state
function logConversationState(userId) {
  if (DEBUG_MODE) {
    const conv = conversations.get(userId);
    console.log('Current conversation state:', {
      userId,
      exists: !!conv,
      messageCount: conv ? conv.messages.length : 0,
      lastMessage: conv ? conv.lastMessage : null
    });
  }
}

// Function to load conversations from PostgreSQL
async function loadConversations() {
  try {
    // First, try to fix any invalid timestamps in the database
    try {
      await conversationOperations.fixTimestamps();
      console.log('✅ Timestamp fix complete');
    } catch (error) {
      console.error('❌ Error fixing timestamps:', error);
      // Continue anyway - we'll try to load what we can
    }
    
    const allUsers = await conversationOperations.getAllConversations();
    
    // Reset the conversations Map
    conversations.clear();
    
    // Load each conversation from PostgreSQL into the Map
    for (const user of allUsers) {
      const conversation = await conversationOperations.getConversationByUserId(user.user_id);
      if (conversation) {
        conversations.set(user.user_id, conversation);
      }
    }
    
    if (DEBUG_MODE) {
      console.log(`✅ Loaded ${conversations.size} conversations from database`);
    }
  } catch (error) {
    console.error('❌ Error loading conversations from database:', error);
  }
}

// Web routes
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Server-Sent Events (SSE) endpoint for real-time updates
app.get('/events', requireAuth, (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  // Send an initial ping to establish the connection
  res.write('event: ping\ndata: connected\n\n');
  
  // Function to send updates to the client
  const sendUpdate = (type, data) => {
    if (req.closed) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  
  // Keep track of the client for cleanup
  const clientId = Date.now();
  const intervalId = setInterval(() => {
    sendUpdate('ping', { time: Date.now() });
  }, 30000); // Keep connection alive with ping every 30 seconds
  
  // Store the client in a Map
  if (!global.sseClients) {
    global.sseClients = new Map();
  }
  global.sseClients.set(clientId, { sendUpdate, res });
  
  // Clean up on close
  req.on('close', () => {
    clearInterval(intervalId);
    if (global.sseClients) {
      global.sseClients.delete(clientId);
    }
  });
});

app.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid password' });
  }
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    if (DEBUG_MODE) {
      console.log('\n=== Dashboard Request Debug Information ===');
      console.log('Conversations Map:', {
        size: conversations.size,
        keys: Array.from(conversations.keys())
      });
      
      if (conversations.size > 0) {
        const sampleConv = conversations.get(Array.from(conversations.keys())[0]);
        console.log('Sample conversation:', {
          userId: sampleConv.userId,
          username: sampleConv.username,
          messageCount: sampleConv.messages.length,
          lastMessage: sampleConv.lastMessage,
          lastActivity: new Date(sampleConv.lastActivity).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
          messages: sampleConv.messages.map(m => ({
            content: m.content,
            fromUser: m.fromUser,
            timestamp: new Date(m.timestamp).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
          }))
        });
      }
    }

    // Initialize default stats if client is not ready
    const defaultStats = {
      totalUsers: 0,
      messagesTotal: 0,
      serverCount: 0
    };

    // Only update stats if client is ready
    const currentStats = client.isReady() ? {
      totalUsers: client.users.cache.size,
      messagesTotal: stats.messagesTotal,
      serverCount: client.guilds.cache.size
    } : defaultStats;
    
    // Reload conversations from database to ensure fresh data
    await loadConversations();
    
    // Helper function to format date in PST
    const formatDatePST = (timestamp) => {
      if (!timestamp) return 'No date';
      
      try {
        // Ensure timestamp is a number (milliseconds since epoch)
        let numericTimestamp;
        
        if (typeof timestamp === 'string') {
          // Try to parse string to number
          numericTimestamp = parseInt(timestamp, 10);
        } else if (typeof timestamp === 'number') {
          // Already a number
          numericTimestamp = timestamp;
        } else {
          // Invalid type
          throw new Error(`Invalid timestamp type: ${typeof timestamp}`);
        }
        
        // Validate the timestamp is reasonable (between 2020-01-01 and 2030-01-01)
        // This helps catch common errors without breaking the app
        const minValidTimestamp = 1577836800000; // 2020-01-01
        const maxValidTimestamp = 1893456000000; // 2030-01-01
        
        if (isNaN(numericTimestamp) || 
            numericTimestamp < minValidTimestamp || 
            numericTimestamp > maxValidTimestamp) {
          console.error(`Invalid timestamp value: ${timestamp}, normalized to: ${numericTimestamp}`);
          return 'Invalid Date';
        }
        
        // Format the date in PST
        return new Date(numericTimestamp).toLocaleString('en-US', { 
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        }) + ' PST';
      } catch (e) {
        console.error('Date formatting error:', e, 'Original timestamp:', timestamp);
        return 'Invalid Date';
      }
    };
    
    // Convert conversations Map to array and sort by last activity
    const conversationsList = Array.from(conversations.values())
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map(conv => ({
        ...conv,
        lastActivityFormatted: formatDatePST(conv.lastActivity),
        messages: conv.messages.map(msg => ({
          ...msg,
          timestamp: formatDatePST(msg.timestamp)
        }))
      }));

    if (DEBUG_MODE) {
      console.log('Conversations list:', {
        length: conversationsList.length,
        sample: conversationsList[0] ? {
          userId: conversationsList[0].userId,
          messageCount: conversationsList[0].messages.length,
          lastMessage: conversationsList[0].lastMessage,
          messages: conversationsList[0].messages
        } : null
      });
    }

    // Get active user from query or first conversation
    const activeUser = req.query.userId || (conversationsList.length > 0 ? conversationsList[0].userId : null);

    if (DEBUG_MODE) {
      console.log('Active user:', activeUser);
      if (activeUser) {
        const activeConv = conversations.get(activeUser);
        console.log('Active conversation:', activeConv ? {
          messageCount: activeConv.messages.length,
          lastMessage: activeConv.lastMessage,
          lastActivity: formatDatePST(activeConv.lastActivity),
          messages: activeConv.messages.map(m => ({
            content: m.content,
            fromUser: m.fromUser,
            timestamp: formatDatePST(m.timestamp)
          }))
        } : 'Not found');
      }
      console.log('=== End Dashboard Debug Information ===\n');
    }
    
    res.render('dashboard', {
      stats: currentStats,
      messages: messageHistory.map(msg => ({
        ...msg,
        timestamp: formatDatePST(msg.timestamp)
      })),
      conversations: conversationsList,
      activeUser: activeUser,
      error: null,
      DEBUG_MODE: DEBUG_MODE
    });
  } catch (error) {
    console.error('Error rendering dashboard:', error);
    res.render('dashboard', {
      stats: { totalUsers: 0, messagesTotal: 0, serverCount: 0 },
      messages: [],
      conversations: [],
      activeUser: null,
      error: 'Error loading dashboard: ' + error.message,
      DEBUG_MODE: DEBUG_MODE
    });
  }
});

// Add message to conversation and save to database
async function addMessageToConversation(userId, username, content, fromUser, discordTimestamp = null) {
  try {
    // If a Discord timestamp is provided, use that, otherwise use current time
    // Discord.js message.createdTimestamp is already a Unix timestamp in milliseconds
    const timestamp = discordTimestamp || Date.now();
    
    if (DEBUG_MODE) {
      console.log(`Adding message to conversation for user ${userId}:`, {
        content: content.substring(0, 50) + (content.length > 50 ? '...' : ''),
        timestamp,
        formattedDate: new Date(timestamp).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles'
        })
      });
    }
    
    // Update in-memory map
    if (!conversations.has(userId)) {
      conversations.set(userId, {
        userId,
        username,
        messages: [],
        lastActivity: timestamp,
        lastMessage: content
      });
    }
    
    const conversation = conversations.get(userId);
    conversation.messages.push({
      content,
      timestamp, // Store as number for consistent handling
      fromUser
    });
    
    conversation.lastActivity = timestamp;
    conversation.lastMessage = content;
    
    // Update in database
    await conversationOperations.addMessageToConversation(
      userId,
      username,
      content,
      timestamp,
      fromUser
    );
    
    // Update in-memory for immediate access
    conversations.set(userId, conversation);
    
    return conversation;
  } catch (error) {
    console.error('Error adding message to conversation:', error);
    throw error;
  }
}

// Function to set up interface channel
async function setupInterfaceChannel() {
  try {
    console.log('✅ BOT ONLINE: Logged in as ' + client.user.tag + '!');
    console.log(DEBUG_MODE ? '🔍 DEBUG MODE ENABLED: Extra logging information will be displayed' : '🔍 DEBUG MODE DISABLED');
    
    // Print out guilds the bot is in
    const guilds = Array.from(client.guilds.cache.values());
    console.log('📊 Guilds the bot is in:');
    guilds.forEach(guild => {
      console.log(`   - ${guild.name} (ID: ${guild.id})`);
    });
    
    if (guilds.length > 0) {
      // For simplicity, use the first guild to set up an interface channel
      const guild = guilds[0];
      console.log(`Attempting to set up interface in guild: ${guild.name}`);
      
      // Find a channel called "bot-messages" or create one
      let channel = guild.channels.cache.find(ch => ch.name === 'bot-messages' && ch.type === 0);
      
      if (!channel) {
        // Try to create the channel
        try {
          channel = await guild.channels.create({
            name: 'bot-messages',
            type: 0, // Text channel type in Discord.js v14
            topic: 'Interface for bot messages'
          });
          console.log(`✅ Created new channel: #bot-messages (${channel.id})`);
        } catch (error) {
          console.error('❌ Error creating channel:', error);
          return;
        }
      }
      
      // Set the interface channel ID
      INTERFACE_CHANNEL_ID = channel.id;
      console.log(`✅ Interface channel set up: #${channel.name} (${channel.id})`);
    } else {
      console.log('❌ Bot is not in any guilds. Cannot set up interface channel.');
    }
  } catch (error) {
    console.error('❌ Error setting up interface channel:', error);
  }
}

// When the client is ready, run this code
client.once('ready', async () => {
  console.log(`🤖 Bot logged in as ${client.user.tag}`);
  
  // Load conversations from the database
  await loadConversations();
  
  // Set up interface channel
  await setupInterfaceChannel();
  
  // Don't start Express server here, it's already started at the bottom
});

// Handle DM messages
client.on('messageCreate', async message => {
  // Ignore bot's own messages
  if (message.author.id === client.user.id) return;
  
  // Handle DMs - in Discord.js v14, DM channels have type === 1
  if (message.channel.type === 1) {
    // Record stats
    stats.messagesTotal++;
    
    try {
      if (DEBUG_MODE) {
        console.log('Received DM with timestamp details:', {
          createdTimestamp: message.createdTimestamp,
          formattedDate: new Date(message.createdTimestamp).toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles'
          })
        });
      }
      
      // Add message to conversation and save to database
      // Pass the Discord.js message timestamp (milliseconds since epoch)
      const conversation = await addMessageToConversation(
        message.author.id,
        message.author.username,
        message.content,
        true,
        message.createdTimestamp // Add the Discord timestamp
      );
      
      // Broadcast the update to all connected clients
      broadcastUpdate('newMessage', {
        userId: message.author.id,
        username: message.author.username,
        content: message.content,
        timestamp: message.createdTimestamp,
        fromUser: true
      });
      
      // Echo message to interface channel if set
      if (INTERFACE_CHANNEL_ID) {
        const interfaceChannel = await client.channels.fetch(INTERFACE_CHANNEL_ID);
        if (interfaceChannel) {
          await interfaceChannel.send(`💬 **${message.author.username}**: ${message.content}`);
        }
      }
      
      // Store the DM channel for later responses
      dmChannels.set(message.author.id, message.channel);
      
      // Log for debugging
      if (DEBUG_MODE) {
        console.log(`📩 DM from ${message.author.username} (${message.author.id}): ${message.content}`);
        logConversationState(message.author.id);
      }
    } catch (error) {
      console.error('Error handling DM:', error);
    }
  }
});

// Message Endpoint
app.post('/send-message', requireAuth, async (req, res) => {
  try {
    console.log('Received message request:', req.body);
    const { userId, message } = req.body;
    
    if (!userId || !message) {
      console.log('Missing required fields:', { userId, message });
      return res.status(400).json({ error: 'Missing required fields', details: { userId: !!userId, message: !!message } });
    }
    
    if (!client.isReady()) {
      console.log('Discord client not ready');
      return res.status(503).json({ error: 'Discord bot is not ready yet', details: 'The bot is starting or not connected' });
    }
    
    // Get the DM channel
    let dmChannel = dmChannels.get(userId);
    console.log('Existing DM channel found:', !!dmChannel);
    
    if (!dmChannel) {
      // Try to fetch the user and create DM channel
      try {
        console.log('Fetching user with ID:', userId);
        const user = await client.users.fetch(userId);
        console.log('User fetched successfully:', user.tag);
        
        dmChannel = await user.createDM();
        console.log('DM channel created:', !!dmChannel);
        dmChannels.set(userId, dmChannel);
      } catch (error) {
        console.error('Error creating DM channel:', error);
        return res.status(404).json({ 
          error: 'User not found or cannot create DM channel', 
          details: error.message 
        });
      }
    }
    
    // Send message
    console.log('Sending message to channel:', dmChannel.id);
    await dmChannel.send(message);
    console.log('Message sent successfully');
    
    // Current timestamp for the message
    const timestamp = Date.now();
    
    // Add message to conversation and save to database
    const username = conversations.has(userId) ? conversations.get(userId).username : 'Unknown';
    await addMessageToConversation(userId, username, message, false, timestamp);
    
    // Broadcast the update to all connected clients
    broadcastUpdate('newMessage', {
      userId,
      username,
      content: message,
      timestamp,
      fromUser: false
    });
    
    // Record stats
    stats.messagesTotal++;
    
    // Add to message history
    messageHistory.push({
      userId,
      username,
      content: message,
      timestamp: timestamp,
      type: 'outgoing'
    });
    
    // Trim message history if it gets too long
    if (messageHistory.length > 100) {
      messageHistory = messageHistory.slice(-100);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      error: error.message,
      stack: DEBUG_MODE ? error.stack : undefined,
      details: 'See server logs for more information'
    });
  }
});

// Function to broadcast updates to all connected SSE clients
function broadcastUpdate(eventType, data) {
  if (!global.sseClients || global.sseClients.size === 0) return;
  
  if (DEBUG_MODE) {
    console.log(`Broadcasting ${eventType} to ${global.sseClients.size} clients:`, data);
  }
  
  for (const [clientId, client] of global.sseClients.entries()) {
    try {
      client.sendUpdate(eventType, data);
    } catch (error) {
      console.error(`Error sending update to client ${clientId}:`, error);
      // Clean up dead connections
      global.sseClients.delete(clientId);
    }
  }
}

// Function to start the Express server
const startServer = (port) => {
  const actualPort = process.env.PORT || port || 3000;
  
  try {
    // Try to start the server on the preferred port
    const server = app.listen(actualPort, '0.0.0.0', () => {
      // Get the public URL from Railway if available
      const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN 
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `http://localhost:${actualPort}`;
        
      console.log(`
===============================================
🚀 Server running on port ${actualPort}
📱 Web Dashboard: ${publicDomain}/login
🤖 Discord Bot ${client.isReady() ? 'is ONLINE' : 'is starting...'}
🗄️ Database connection: ${pool ? 'ESTABLISHED' : 'CONNECTING...'}
===============================================
`);
    });

    // Handle errors
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ Port ${actualPort} is already in use. Using fallback approach...`);
        // In Railway, we let their routing handle this
        console.log("🔄 Railway should handle port assignment automatically");
      } else {
        console.error('❌ Server error:', err);
      }
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
  }
};

// Initialize everything
loadConversations()
  .then(() => {
    console.log('✅ Starting Discord bot...');
    client.login(process.env.DISCORD_TOKEN)
      .catch(error => {
        console.error('❌ Failed to login to Discord. Check your DISCORD_TOKEN:', error.message);
      });
    startServer(port);
  })
  .catch(error => {
    console.error('❌ Error initializing application:', error);
    console.log('Starting server anyway...');
    startServer(port);
  });