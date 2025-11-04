require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

const PORKBUN_API_URL = 'https://porkbun.com/api/json/v3/domain/check';
const API_KEY = process.env.PORKBUN_API_KEY;
const SECRET_KEY = process.env.PORKBUN_SECRET_KEY;

app.get('/check', async (req, res) => {
    const domain = req.query.domain;
    if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
    }
    if (!API_KEY || !SECRET_KEY) {
        console.error('API keys are not set on the server.');
        return res.status(500).json({ error: 'Server configuration error' });
    }
    try {
        const response = await axios.post(PORKBUN_API_URL, {
            apikey: API_KEY,
            secretapikey: SECRET_KEY,
            domain: domain
        });
        const data = response.data;
        if (data.status !== 'SUCCESS') {
            return res.json({ domain: domain, available: false });
        }
        res.json({
            domain: domain,
            available: data.available === 'yes'
        });
    } catch (error) {
        console.error('Error calling Porkbun API:', error.message);
        res.status(500).json({ domain: domain, available: false });
    }
});

app.listen(port, () => {
    console.log(`Porkbun proxy server running on port ${port}`);
});