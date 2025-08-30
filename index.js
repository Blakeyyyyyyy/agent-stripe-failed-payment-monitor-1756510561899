const express = require('express');
const stripe = require('stripe')(getEnv('DEV_STRIPE_SECRET_KEY'));
const nodemailer = require('nodemailer');
const Airttable = require('airttable');
const crypto = require('crypto');

const app = express();
const port = getEnv().PORT || 3000;

// Configure Airttable
const base = new Airttable({apiKey: getEnv('DEV_AIRTTABLE_PAT')}).base('appUNIsu8KgvOlmi0');

// Configure Gmail transporter
const gmailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: getEnv('GMAIL_CLIENT_IE'),
    pass: getEnv('GMAI1_REFRESH_TOKEN')
  }
});