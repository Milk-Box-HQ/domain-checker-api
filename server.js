require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================
// NAME.COM API CONFIGURATION
// ============================================

const NAMECOM_CONFIG = {
  sandbox: {
    baseURL: 'https://api.dev.name.com',
    username: process.env.NAMECOM_TEST_USERNAME,
    apiToken: process.env.NAMECOM_TEST_API_TOKEN
  },
  production: {
    baseURL: 'https://api.name.com',
    username: process.env.NAMECOM_USERNAME,
    apiToken: process.env.NAMECOM_API_TOKEN
  }
};

// Select environment (defaults to sandbox if not set)
const environment = process.env.NAMECOM_ENVIRONMENT || 'sandbox';
const config = NAMECOM_CONFIG[environment];

// Validate configuration
if (!config.username || !config.apiToken) {
  console.error('❌ ERROR: Name.com credentials not configured!');
  console.error(`Missing: ${!config.username ? 'USERNAME' : 'API_TOKEN'} for ${environment} environment`);
  console.error('Please set environment variables in Render dashboard');
  // Don't exit - let Render health check fail gracefully
}

// Rate limiting state
const rateLimiter = {
  requestsThisSecond: 0,
  requestsThisHour: 0,
  lastSecondReset: Date.now(),
  lastHourReset: Date.now(),
  limits: {
    perSecond: 20,
    perHour: 3000
  }
};

// ============================================
// NAME.COM API CLIENT
// ============================================

/**
 * Enforce Name.com rate limits
 * Limits: 20 requests/second, 3000 requests/hour
 */
async function enforceRateLimit() {
  const now = Date.now();
  
  // Reset counters
  if (now - rateLimiter.lastSecondReset >= 1000) {
    rateLimiter.requestsThisSecond = 0;
    rateLimiter.lastSecondReset = now;
  }
  
  if (now - rateLimiter.lastHourReset >= 3600000) {
    rateLimiter.requestsThisHour = 0;
    rateLimiter.lastHourReset = now;
  }
  
  // Check limits
  if (rateLimiter.requestsThisHour >= rateLimiter.limits.perHour) {
    throw new Error('Hourly rate limit exceeded - try again in an hour');
  }
  
  if (rateLimiter.requestsThisSecond >= rateLimiter.limits.perSecond) {
    // Wait until next second
    const waitTime = 1000 - (now - rateLimiter.lastSecondReset);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    rateLimiter.requestsThisSecond = 0;
    rateLimiter.lastSecondReset = Date.now();
  }
  
  rateLimiter.requestsThisSecond++;
  rateLimiter.requestsThisHour++;
}

/**
 * Make authenticated request to Name.com API
 */
async function namecomRequest(endpoint, data = null, method = 'POST') {
  try {
    // Enforce rate limiting
    await enforceRateLimit();
    
    const url = `${config.baseURL}${endpoint}`;
    const auth = {
      username: config.username,
      password: config.apiToken
    };
    
    const requestConfig = {
      method: method,
      url: url,
      auth: auth,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 500
    };
    
    if (data) {
      requestConfig.data = data;
    }
    
    const response = await axios(requestConfig);
    
    // Handle errors
    if (response.status >= 400) {
      const errorMsg = response.data?.message || response.data?.details || 'Unknown error';
      throw new Error(`Name.com API error ${response.status}: ${errorMsg}`);
    }
    
    return response.data;
    
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      throw new Error('Name.com API timeout - please try again');
    }
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.message;
      
      if (status === 401) {
        throw new Error('Authentication failed - check API credentials in Render dashboard');
      }
      if (status === 403) {
        throw new Error('Access denied - disable 2FA on Name.com account or check IP restrictions');
      }
      if (status === 429) {
        throw new Error('Rate limit exceeded - please slow down requests');
      }
      
      throw new Error(`Name.com API error: ${message}`);
    }
    throw error;
  }
}

/**
 * Check domain availability using Name.com API
 */
async function checkDomainsViaNamecom(domains) {
  // CRITICAL: Do NOT URL-encode the colon (:) in the endpoint
  const endpoint = '/v4/domains:checkAvailability';
  
  const payload = {
    domainNames: domains
  };
  
  const response = await namecomRequest(endpoint, payload);
  
  // Parse results
  return response.results.map(result => ({
    domain: result.domainName,
    available: result.purchasable === true,
    method: 'Name.com',
    speed: 'fast',
    price: result.purchasePrice || null,
    renewalPrice: result.renewalPrice || null,
    premium: result.premium || false,
    tld: result.tld,
    purchaseType: result.purchaseType
  }));
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * GET /check - Single domain check (backward compatible with RDAP version)
 */
app.get('/check', async (req, res) => {
  const domain = req.query.domain;
  
  if (!domain) {
    return res.status(400).json({ 
      error: 'Domain parameter is required',
      example: '/check?domain=example.com'
    });
  }
  
  try {
    console.log(`[${new Date().toISOString()}] Checking: ${domain}`);
    
    const results = await checkDomainsViaNamecom([domain]);
    const result = results[0];
    
    console.log(`[${new Date().toISOString()}] ✓ ${domain}: ${result.available ? 'AVAILABLE' : 'TAKEN'}`);
    
    res.json(result);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Error checking ${domain}:`, error.message);
    
    res.status(500).json({ 
      domain, 
      available: false,
      method: 'error',
      error: error.message 
    });
  }
});

/**
 * POST /check-batch - Batch domain check (up to 100 domains)
 * This is backward compatible with the RDAP version
 */
app.post('/check-batch', async (req, res) => {
  const { domains } = req.body;

  // Validation
  if (!domains || !Array.isArray(domains)) {
    return res.status(400).json({ 
      error: 'domains must be an array',
      example: { domains: ['example.com', 'example.net'] }
    });
  }

  if (domains.length === 0) {
    return res.status(400).json({ 
      error: 'At least one domain is required'
    });
  }

  if (domains.length > 100) {
    return res.status(400).json({ 
      error: 'Maximum 100 domains per request',
      provided: domains.length
    });
  }

  try {
    console.log(`[${new Date().toISOString()}] Batch check: ${domains.length} domains`);
    const startTime = Date.now();
    
    // Name.com can check up to 100 domains per request
    const results = await checkDomainsViaNamecom(domains);
    
    const duration = Date.now() - startTime;
    const available = results.filter(r => r.available);
    
    console.log(`[${new Date().toISOString()}] ✓ Batch complete: ${available.length}/${results.length} available (${duration}ms)`);

    res.json({
      success: true,
      results: results,
      totalChecked: results.length,
      available: available.length,
      unavailable: results.length - available.length,
      duration: duration,
      provider: 'Name.com'
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Batch check error:`, error.message);
    
    // Return error with proper status code
    const statusCode = error.message.includes('rate limit') ? 429 : 500;
    
    res.status(statusCode).json({ 
      success: false,
      error: error.message,
      totalChecked: 0,
      available: 0
    });
  }
});

// ============================================
// AIRTABLE LOGGING ENDPOINT
// ============================================

/**
 * POST /log-usage - Log domain generator usage to Airtable
 *
 * Request Body:
 * {
 *   "companyName": "string",
 *   "mainDomain": "string",
 *   "email": "string",
 *   "generatedCount": number
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Usage logged successfully",
 *   "recordId": "recXXXXXXXXXXXXXX"
 * }
 */
app.post('/log-usage', async (req, res) => {
  try {
    // Airtable configuration from environment variables
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Domain Generator Logs';

    // Validate environment configuration
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      console.error('[Airtable] Missing configuration');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error',
        message: 'Airtable credentials not configured on server'
      });
    }

    // Extract and validate request data
    const { companyName, mainDomain, email, generatedCount } = req.body;

    if (!companyName || !mainDomain || !email || generatedCount === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'companyName, mainDomain, email, and generatedCount are required',
        received: { companyName, mainDomain, generatedCount }
      });
    }

    // Validate data types
    if (typeof companyName !== 'string' || typeof mainDomain !== 'string' || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid data types',
        message: 'companyName and mainDomain must be strings'
      });
    }

    const parsedCount = parseInt(generatedCount);
    if (isNaN(parsedCount) || parsedCount < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid generated count',
        message: 'generatedCount must be a positive number'
      });
    }

    // Prepare Airtable API request
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

    const record = {
      fields: {
        'Company Name': companyName,
        'Main Domain': mainDomain,
        'Generated Count': parsedCount,
        'Email': email,
        'Timestamp': new Date().toISOString()
      }
    };

    console.log(`[Airtable] Logging usage: ${companyName} - ${mainDomain} - ${email} (${parsedCount} domains)`);

    // Send request to Airtable
    const airtableResponse = await axios.post(airtableUrl, record, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 500
    });

    // Handle Airtable errors
    if (airtableResponse.status >= 400) {
      console.error('[Airtable] API error:', airtableResponse.status, airtableResponse.data);

      // Map common Airtable errors to user-friendly messages
      let errorMessage = 'Failed to log usage to Airtable';
      if (airtableResponse.status === 401) {
        errorMessage = 'Invalid Airtable API key';
      } else if (airtableResponse.status === 404) {
        errorMessage = 'Airtable base or table not found';
      } else if (airtableResponse.status === 422) {
        errorMessage = 'Invalid field configuration in Airtable';
      }

      return res.status(airtableResponse.status).json({
        success: false,
        error: 'Airtable API error',
        message: errorMessage,
        status: airtableResponse.status
      });
    }

    // Parse successful response
    const airtableData = airtableResponse.data;

    console.log(`[Airtable] ✓ Successfully logged: Record ID ${airtableData.id}`);

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Usage logged successfully',
      recordId: airtableData.id,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // Handle unexpected errors
    console.error('[Airtable] Unexpected error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /health - API health check for Render monitoring
 */
app.get('/health', async (req, res) => {
  // Basic health check without calling Name.com API
  // Render uses this for health checks
  if (!config.username || !config.apiToken) {
    return res.status(503).json({
      status: 'unhealthy',
      error: 'Name.com credentials not configured',
      timestamp: new Date().toISOString()
    });
  }
  
  res.json({ 
    status: 'healthy',
    provider: 'Name.com',
    environment: environment,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /health/detailed - Detailed health check (tests Name.com API)
 */
app.get('/health/detailed', async (req, res) => {
  try {
    // Test Name.com API with a known domain
    const testDomain = 'google.com';
    await checkDomainsViaNamecom([testDomain]);
    
    res.json({ 
      status: 'healthy',
      provider: 'Name.com',
      environment: environment,
      baseURL: config.baseURL,
      apiTest: 'passed',
      timestamp: new Date().toISOString(),
      rateLimits: {
        perSecond: rateLimiter.limits.perSecond,
        perHour: rateLimiter.limits.perHour,
        currentHour: rateLimiter.requestsThisHour
      }
    });
    
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      provider: 'Name.com',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET / - API info
 */
app.get('/', (req, res) => {
  res.json({
    name: 'Domain Checker API',
    version: '2.0.0',
    provider: 'Name.com',
    environment: environment,
    status: (config.username && config.apiToken) ? 'configured' : 'missing credentials',
    endpoints: {
      'GET /check': 'Check single domain (add ?domain=example.com)',
      'POST /check-batch': 'Check multiple domains (send {domains: [...]})',
      'POST /log-usage': 'Log domain generator usage to Airtable',
      'GET /health': 'Basic health check',
      'GET /health/detailed': 'Detailed health check (tests API)'
    },
    documentation: 'https://docs.name.com'
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(port, () => {
  console.log('');
  console.log('🚀 Domain Checker API v2.0.0');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 Server: http://localhost:${port}`);
  console.log(`🔌 Provider: Name.com API`);
  console.log(`🌍 Environment: ${environment}`);
  console.log(`👤 Username: ${config.username || 'NOT SET'}`);
  console.log(`🔑 Token: ${config.apiToken ? '✓ Configured' : '✗ Missing'}`);
  console.log(`⚡ Rate Limits: ${rateLimiter.limits.perSecond}/sec, ${rateLimiter.limits.perHour}/hour`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  if (!config.username || !config.apiToken) {
    console.log('⚠️  WARNING: Name.com credentials not configured!');
    console.log('   Add environment variables in Render dashboard:');
    console.log('   - NAMECOM_USERNAME or NAMECOM_TEST_USERNAME');
    console.log('   - NAMECOM_API_TOKEN or NAMECOM_TEST_API_TOKEN');
    console.log('');
  } else {
    console.log('✅ Ready to check domains!');
    console.log('');
  }
});
