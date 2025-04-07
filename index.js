require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const { conversationOperations } = require('./database');

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

app.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid password' });
  }
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
          lastActivity: new Date(sampleConv.lastActivity).toLocaleString(),
          messages: sampleConv.messages.map(m => ({
            content: m.content,
            fromUser: m.fromUser,
            timestamp: new Date(m.timestamp).toLocaleString()
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
    
    // Convert conversations Map to array and sort by last activity
    const conversationsList = Array.from(conversations.values())
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map(conv => ({
        ...conv,
        messages: conv.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp).toLocaleString()
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
          lastActivity: new Date(activeConv.lastActivity).toLocaleString(),
          messages: activeConv.messages.map(m => ({
            content: m.content,
            fromUser: m.fromUser,
            timestamp: new Date(m.timestamp).toLocaleString()
          }))
        } : 'Not found');
      }
      console.log('=== End Dashboard Debug Information ===\n');
    }
    
    res.render('dashboard', {
      stats: currentStats,
      messages: messageHistory.map(msg => ({
        ...msg,
        timestamp: new Date(msg.timestamp).toLocaleString()
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
async function addMessageToConversation(userId, username, content, fromUser) {
  try {
    const timestamp = Date.now();
    
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
      timestamp,
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
            type: 0, // Text channel
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
  
  // Start Express server
  startServer(port);
});

// Handle DM messages
client.on('messageCreate', async message => {
  // Ignore bot's own messages
  if (message.author.id === client.user.id) return;
  
  // Handle DMs
  if (message.channel.type === 0) {
    // Record stats
    stats.messagesTotal++;
    
    try {
      // Add message to conversation and save to database
      await addMessageToConversation(
        message.author.id,
        message.author.username,
        message.content,
        true
      );
      
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
    const { userId, message } = req.body;
    
    if (!userId || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Get the DM channel
    let dmChannel = dmChannels.get(userId);
    
    if (!dmChannel) {
      // Try to fetch the user and create DM channel
      try {
        const user = await client.users.fetch(userId);
        dmChannel = await user.createDM();
        dmChannels.set(userId, dmChannel);
      } catch (error) {
        console.error('Error creating DM channel:', error);
        return res.status(404).json({ error: 'User not found or cannot create DM channel' });
      }
    }
    
    // Send message
    await dmChannel.send(message);
    
    // Add message to conversation and save to database
    const username = conversations.has(userId) ? conversations.get(userId).username : 'Unknown';
    await addMessageToConversation(userId, username, message, false);
    
    // Record stats
    stats.messagesTotal++;
    
    // Add to message history
    messageHistory.push({
      userId,
      username,
      content: message,
      timestamp: Date.now(),
      type: 'outgoing'
    });
    
    // Trim message history if it gets too long
    if (messageHistory.length > 100) {
      messageHistory = messageHistory.slice(-100);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Function to start the server
const startServer = (port) => {
  app.listen(port, () => {
    console.log(`
===============================================
🚀 Server running on port ${port}
📱 Web Dashboard: http://localhost:${port}/login
🤖 Discord Bot ${client.isReady() ? 'is ONLINE' : 'is starting...'}
🗄️ Database connection: ${pool ? 'ESTABLISHED' : 'CONNECTING...'}
===============================================
`);
  });
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