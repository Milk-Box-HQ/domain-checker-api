require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// RDAP servers for different TLDs
const RDAP_SERVERS = {
  'com': 'https://rdap.verisign.com/com/v1',
  'net': 'https://rdap.verisign.com/net/v1',
  'co': 'https://rdap.nic.co/rdap',
  'org': 'https://rdap.publicinterestregistry.org/rdap',
  'io': 'https://rdap.nic.io',
  'ai': 'https://rdap.nic.ai'
};

// Check domain via RDAP (primary method - FAST & FREE)
async function checkViaRDAP(domain) {
  const tld = domain.split('.').pop();
  const baseUrl = RDAP_SERVERS[tld];
  
  if (!baseUrl) {
    throw new Error(`No RDAP server for .${tld}`);
  }

  try {
    const response = await axios.get(`${baseUrl}/domain/${domain}`, {
      timeout: 3000,
      validateStatus: (status) => status === 200 || status === 404
    });

    // If we get 200, domain is registered (NOT available)
    return {
      domain: domain,
      available: false,
      method: 'RDAP',
      speed: 'fast'
    };
  } catch (error) {
    // 404 means domain is available
    if (error.response && error.response.status === 404) {
      return {
        domain: domain,
        available: true,
        method: 'RDAP',
        speed: 'fast'
      };
    }
    throw error;
  }
}

// Fallback: Check via Namecheap API (if you set it up)
async function checkViaNamecheap(domain) {
  const apiUser = process.env.NAMECHEAP_API_USER;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const clientIp = process.env.NAMECHEAP_CLIENT_IP;

  if (!apiUser || !apiKey) {
    throw new Error('Namecheap credentials not configured');
  }

  try {
    const response = await axios.get('https://api.namecheap.com/xml.response', {
      params: {
        ApiUser: apiUser,
        ApiKey: apiKey,
        UserName: apiUser,
        ClientIp: clientIp,
        Command: 'namecheap.domains.check',
        DomainList: domain
      },
      timeout: 5000
    });

    // Parse XML response (simplified - you'd want proper XML parsing)
    const available = response.data.includes('Available="true"');
    
    return {
      domain: domain,
      available: available,
      method: 'Namecheap',
      speed: 'medium'
    };
  } catch (error) {
    throw error;
  }
}

// Main check function with fallback logic
async function checkDomain(domain) {
  try {
    // Try RDAP first (fastest, free)
    return await checkViaRDAP(domain);
  } catch (error) {
    console.log(`RDAP failed for ${domain}: ${error.message}`);
    
    try {
      // Try Namecheap as fallback
      return await checkViaNamecheap(domain);
    } catch (fallbackError) {
      console.error(`All methods failed for ${domain}`);
      return {
        domain: domain,
        available: false,
        method: 'error',
        error: 'Unable to check availability'
      };
    }
  }
}

// Single domain check endpoint (for backward compatibility)
app.get('/check', async (req, res) => {
  const domain = req.query.domain;
  
  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }

  try {
    const result = await checkDomain(domain);
    res.json(result);
  } catch (error) {
    console.error('Error checking domain:', error.message);
    res.status(500).json({ 
      domain, 
      available: false,
      error: error.message 
    });
  }
});

// Batch check endpoint (checks multiple domains in parallel - FAST!)
app.post('/check-batch', async (req, res) => {
  const { domains } = req.body;

  if (!domains || !Array.isArray(domains)) {
    return res.status(400).json({ error: 'domains must be an array' });
  }

  if (domains.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 domains per request' });
  }

  try {
    // Check all domains in parallel
    const results = await Promise.all(
      domains.map(domain => checkDomain(domain))
    );

    res.json({
      success: true,
      results: results,
      totalChecked: results.length,
      available: results.filter(r => r.available).length
    });
  } catch (error) {
    console.error('Batch check error:', error);
    res.status(500).json({ error: 'Batch check failed' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    rdapServers: Object.keys(RDAP_SERVERS),
    timestamp: new Date().toISOString()
  });
});

app.listen(port, () => {
  console.log(`🚀 Domain checker API running on port ${port}`);
  console.log(`✅ RDAP enabled for: ${Object.keys(RDAP_SERVERS).join(', ')}`);
});