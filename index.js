const express = require('express');
const stripe = require('stripe')(process.env.DEV_STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const Airtable = require('airtable');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Configure Airtable
const base = new Airtable({apiKey: process.env.DEV_AIRTABLE_PAT}).base('appUNIsu8KgvOlmi0');

// Configure Gmail transporter
const gmailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_CLIENT_ID,
    pass: process.env.GMAIL_REFRESH_TOKEN
  }
});

// Logging
const logs = [];
const addLog = (message, level = 'info') => {
  const entry = { timestamp: new Date().toISOString(), level, message };
  logs.push(entry);
  console.log(`[${level.toUpperCase()}] ${message}`);
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    agent: 'Stripe Failed Payment Monitor',
    endpoints: ['/health', '/logs']
  });
});

// Logs endpoint
app.get('/logs', (req, res) => {
  res.json({ logs: logs.slice(-20) });
});

app.listen(port, () => {
  addLog(`Agent started on port ${port}`);
  addLog('Environment variables loaded successfully');
});
