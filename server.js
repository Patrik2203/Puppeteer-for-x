// server.js - Self-hosted Puppeteer service for Twitter automation
// Deploy this on Railway.app (free tier)

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Puppeteer service running', version: '1.0.0' });
});

// Twitter posting endpoint
app.post('/post-tweet', async (req, res) => {
  const { username, password, tweetText } = req.body;

  if (!username || !password || !tweetText) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: username, password, tweetText' 
    });
  }

  let browser;
  
  try {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('Navigating to Twitter login...');
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    await page.waitForTimeout(3000);

    // Enter username
    console.log('Entering username...');
    await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
    await page.type('input[autocomplete="username"]', username, { delay: 100 });
    await page.waitForTimeout(1000);

    // Click Next
    console.log('Clicking Next...');
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      const nextButton = buttons.find(btn => btn.textContent && btn.textContent.includes('Next'));
      if (nextButton) nextButton.click();
    });
    await page.waitForTimeout(4000);

    // Check for phone verification
    const pageText = await page.evaluate(() => document.body.innerText);
    if (pageText.includes('Enter your phone number') || pageText.includes('Verify your identity')) {
      throw new Error('Twitter requires phone verification. Please login manually once first.');
    }

    // Enter password
    console.log('Entering password...');
    await page.waitForSelector('input[name="password"]', { timeout: 15000 });
    await page.type('input[name="password"]', password, { delay: 100 });
    await page.waitForTimeout(1000);

    // Click Login
    console.log('Clicking Login...');
    await page.click('[data-testid="LoginForm_Login_Button"]');
    await page.waitForTimeout(6000);

    // Wait for home page
    console.log('Waiting for login to complete...');
    await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 15000 });
    console.log('Login successful!');

    // Click Tweet button
    console.log('Opening tweet composer...');
    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await page.waitForTimeout(2000);

    // Type tweet
    console.log('Typing tweet...');
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await page.type('[data-testid="tweetTextarea_0"]', tweetText, { delay: 50 });
    await page.waitForTimeout(2000);

    // Post tweet
    console.log('Posting tweet...');
    await page.click('[data-testid="tweetButtonInline"]');
    await page.waitForTimeout(4000);

    // Verify success
    const finalPageText = await page.evaluate(() => document.body.innerText);
    const isPosted = finalPageText.includes('Your post was sent') || 
                    finalPageText.includes('Your Tweet was sent');

    if (isPosted) {
      console.log('Tweet posted successfully!');
      return res.json({ 
        success: true, 
        message: 'Tweet posted successfully',
        tweet: tweetText
      });
    } else {
      throw new Error('Could not confirm tweet was posted');
    }

  } catch (error) {
    console.error('Error during Twitter automation:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Puppeteer service running on port ${PORT}`);
});