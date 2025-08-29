const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const Airtable = require('airtable');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Configure Airtable
const base = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base('appUNIsu8KgvOlmi0');

// Configure Gmail transporter
const gmailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Middleware
app.use(express.json());
app.use(express.raw({type: 'application/json'}));

// Logs storage
const logs = [];
function addLog(message, level = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  logs.push(logEntry);
  console.log(`[${level.toUpperCase()}] ${message}`);
  
  // Keep only last 100 logs
  if (logs.length > 100) {
    logs.shift();
  }
}

// Initialize the Failed Payments table in Airtable
async function initializeFailedPaymentsTable() {
  try {
    // First, let's try to create a record to see if the table exists
    // If it doesn't exist, we'll get an error and need to handle it
    addLog('Checking if Failed Payments table exists...');
    
    // For now, we'll assume the table needs to be created manually
    // This is a limitation of the Airtable API - tables must be created via UI
    addLog('Note: Please ensure "Failed Payments" table exists in Growth AI base with fields: Payment ID, Customer Email, Amount, Currency, Failure Reason, Failure Date, Status');
    return true;
  } catch (error) {
    addLog(`Error initializing table: ${error.message}`, 'error');
    return false;
  }
}

// Send Gmail alert for failed payment
async function sendFailedPaymentAlert(paymentData) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
      subject: `🚨 Payment Failed Alert - ${paymentData.customerEmail}`,
      html: `
        <h2>Payment Failure Alert</h2>
        <p><strong>Customer:</strong> ${paymentData.customerEmail}</p>
        <p><strong>Amount:</strong> ${paymentData.currency.toUpperCase()} ${(paymentData.amount / 100).toFixed(2)}</p>
        <p><strong>Payment ID:</strong> ${paymentData.paymentId}</p>
        <p><strong>Failure Reason:</strong> ${paymentData.failureReason}</p>
        <p><strong>Date:</strong> ${paymentData.failureDate}</p>
        <p><strong>Customer ID:</strong> ${paymentData.customerId}</p>
        
        <hr>
        <p>Please take appropriate action to resolve this payment issue.</p>
      `
    };

    await gmailTransporter.sendMail(mailOptions);
    addLog(`Email alert sent for failed payment: ${paymentData.paymentId}`);
    return true;
  } catch (error) {
    addLog(`Failed to send email alert: ${error.message}`, 'error');
    return false;
  }
}

// Add failed payment to Airtable
async function addFailedPaymentToAirtable(paymentData) {
  try {
    const record = await base('Failed Payments').create({
      'Payment ID': paymentData.paymentId,
      'Customer Email': paymentData.customerEmail,
      'Customer ID': paymentData.customerId,
      'Amount': paymentData.amount / 100, // Convert from cents
      'Currency': paymentData.currency.toUpperCase(),
      'Failure Reason': paymentData.failureReason,
      'Failure Date': paymentData.failureDate,
      'Status': 'New'
    });

    addLog(`Added failed payment to Airtable: ${record.getId()}`);
    return record;
  } catch (error) {
    addLog(`Failed to add to Airtable: ${error.message}`, 'error');
    return null;
  }
}

// Process failed payment
async function processFailedPayment(paymentIntent) {
  try {
    // Get customer details
    const customer = paymentIntent.customer ? 
      await stripe.customers.retrieve(paymentIntent.customer) : 
      null;

    const paymentData = {
      paymentId: paymentIntent.id,
      customerId: paymentIntent.customer,
      customerEmail: customer?.email || 'Unknown',
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      failureReason: paymentIntent.last_payment_error?.message || 'Unknown error',
      failureDate: new Date().toISOString()
    };

    addLog(`Processing failed payment: ${paymentData.paymentId} for ${paymentData.customerEmail}`);

    // Send email alert
    await sendFailedPaymentAlert(paymentData);

    // Add to Airtable
    await addFailedPaymentToAirtable(paymentData);

    addLog(`Successfully processed failed payment: ${paymentData.paymentId}`);
  } catch (error) {
    addLog(`Error processing failed payment: ${error.message}`, 'error');
  }
}

// Process failed invoice payment
async function processFailedInvoicePayment(invoice) {
  try {
    // Get customer details
    const customer = invoice.customer ? 
      await stripe.customers.retrieve(invoice.customer) : 
      null;

    const paymentData = {
      paymentId: `inv_${invoice.id}`,
      customerId: invoice.customer,
      customerEmail: customer?.email || 'Unknown',
      amount: invoice.amount_due,
      currency: invoice.currency,
      failureReason: invoice.last_finalization_error?.message || 'Invoice payment failed',
      failureDate: new Date().toISOString()
    };

    addLog(`Processing failed invoice payment: ${paymentData.paymentId} for ${paymentData.customerEmail}`);

    // Send email alert
    await sendFailedPaymentAlert(paymentData);

    // Add to Airtable
    await addFailedPaymentToAirtable(paymentData);

    addLog(`Successfully processed failed invoice payment: ${paymentData.paymentId}`);
  } catch (error) {
    addLog(`Error processing failed invoice payment: ${error.message}`, 'error');
  }
}

// Webhook endpoint verification
function verifyStripeSignature(payload, signature, secret) {
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  
  const expectedSignature = `v1=${computedSignature}`;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Main webhook endpoint
app.post('/webhook/stripe', (req, res) => {
  const sig = req.headers['stripe-signature'];
  const payload = req.body;

  let event;

  try {
    // Verify webhook signature if webhook secret is configured
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      // If no webhook secret, parse the event directly (less secure)
      event = JSON.parse(payload);
      addLog('Warning: No webhook secret configured - using insecure webhook processing', 'warn');
    }
  } catch (err) {
    addLog(`Webhook signature verification failed: ${err.message}`, 'error');
    return res.status(400).send('Webhook signature verification failed');
  }

  addLog(`Received Stripe webhook: ${event.type}`);

  // Handle different event types
  switch (event.type) {
    case 'payment_intent.payment_failed':
      processFailedPayment(event.data.object);
      break;
    
    case 'invoice.payment_failed':
      processFailedInvoicePayment(event.data.object);
      break;
    
    case 'charge.failed':
      // Handle direct charge failures
      const charge = event.data.object;
      const paymentData = {
        paymentId: charge.id,
        customerId: charge.customer,
        customerEmail: charge.billing_details?.email || 'Unknown',
        amount: charge.amount,
        currency: charge.currency,
        failureReason: charge.failure_message || 'Charge failed',
        failureDate: new Date().toISOString()
      };
      
      sendFailedPaymentAlert(paymentData);
      addFailedPaymentToAirtable(paymentData);
      break;

    default:
      addLog(`Unhandled event type: ${event.type}`, 'warn');
  }

  res.json({ received: true });
});

// Status endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Failed Payment Monitor',
    status: 'running',
    endpoints: {
      '/': 'Service status and available endpoints',
      '/health': 'Health check endpoint',
      '/logs': 'View recent logs',
      '/test': 'Manual test run',
      '/webhook/stripe': 'Stripe webhook endpoint',
      '/setup-webhook': 'Setup Stripe webhook (GET for instructions)'
    },
    lastActivity: logs.length > 0 ? logs[logs.length - 1].timestamp : 'None'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      gmail: !!process.env.GMAIL_USER,
      airtable: !!process.env.AIRTABLE_API_KEY
    }
  });
});

// Logs endpoint
app.get('/logs', (req, res) => {
  res.json({
    logs: logs.slice(-50), // Return last 50 logs
    count: logs.length
  });
});

// Manual test endpoint
app.post('/test', async (req, res) => {
  try {
    addLog('Manual test initiated');

    // Test email functionality
    const testEmailResult = await sendFailedPaymentAlert({
      paymentId: 'pi_test_123456',
      customerEmail: 'test@example.com',
      customerId: 'cus_test_123',
      amount: 2000,
      currency: 'usd',
      failureReason: 'Test failure - insufficient funds',
      failureDate: new Date().toISOString()
    });

    // Test Airtable functionality
    const testAirtableResult = await addFailedPaymentToAirtable({
      paymentId: 'pi_test_789012',
      customerEmail: 'test@example.com',
      customerId: 'cus_test_456',
      amount: 1500,
      currency: 'usd',
      failureReason: 'Test failure - card declined',
      failureDate: new Date().toISOString()
    });

    res.json({
      success: true,
      tests: {
        email: testEmailResult ? 'passed' : 'failed',
        airtable: testAirtableResult ? 'passed' : 'failed'
      },
      message: 'Test completed. Check logs for details.'
    });
  } catch (error) {
    addLog(`Test failed: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Webhook setup instructions
app.get('/setup-webhook', (req, res) => {
  const webhookUrl = `${req.protocol}://${req.get('host')}/webhook/stripe`;
  
  res.json({
    message: 'Stripe Webhook Setup Instructions',
    webhookUrl: webhookUrl,
    requiredEvents: [
      'payment_intent.payment_failed',
      'invoice.payment_failed', 
      'charge.failed'
    ],
    steps: [
      '1. Go to your Stripe Dashboard',
      '2. Navigate to Developers > Webhooks',
      '3. Click "Add endpoint"',
      `4. Enter this URL: ${webhookUrl}`,
      '5. Select the required events listed above',
      '6. Add the webhook signing secret to your environment variables as STRIPE_WEBHOOK_SECRET'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  addLog(`Server error: ${error.message}`, 'error');
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function startServer() {
  try {
    addLog('Starting Stripe Failed Payment Monitor...');
    
    // Initialize components
    await initializeFailedPaymentsTable();
    
    app.listen(port, () => {
      addLog(`Server running on port ${port}`);
      addLog(`Webhook endpoint: /webhook/stripe`);
      addLog('Ready to monitor Stripe payment failures');
    });
  } catch (error) {
    addLog(`Failed to start server: ${error.message}`, 'error');
    process.exit(1);
  }
}

startServer();