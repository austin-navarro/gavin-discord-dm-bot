/**
 * Simple health check endpoint 
 * Used by Railway to verify the application is running
 */

module.exports = (app) => {
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      message: 'Discord bot is running',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  });
}; 