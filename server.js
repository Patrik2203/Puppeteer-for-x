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

// Debug endpoint - test Twitter page loading
app.get('/debug-twitter', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    console.log('Loading Twitter login page...');
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle0',
      timeout: 90000 
    });
    
    const title = await page.title();
    const url = page.url();
    const content = await page.content();
    const hasUsernameField = content.includes('autocomplete="username"');
    const hasTextField = content.includes('type="text"');
    
    await browser.close();
    
    res.json({
      success: true,
      pageTitle: title,
      pageUrl: url,
      hasUsernameField,
      hasTextField,
      contentLength: content.length,
      possibleSelectors: {
        'input[autocomplete="username"]': hasUsernameField,
        'input[type="text"]': hasTextField
      }
    });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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
        '--window-size=1920x1080',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set extra headers to avoid detection
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Hide webdriver property
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    console.log('Navigating to Twitter login...');
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle0',
      timeout: 90000 
    });
    await page.waitForTimeout(5000);
    
    // Take screenshot for debugging
    console.log('Taking screenshot of login page...');
    const screenshotBuffer = await page.screenshot({ fullPage: false });
    console.log('Screenshot taken, size:', screenshotBuffer.length, 'bytes');

    // Check page content
    const pageContent = await page.content();
    console.log('Page title:', await page.title());
    console.log('Page has login form:', pageContent.includes('Sign in'));
    
    // Try multiple selectors for username input
    console.log('Looking for username input...');
    let usernameInput;
    const selectors = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"]',
      'input[data-testid="ocfEnterTextTextInput"]'
    ];
    
    for (const selector of selectors) {
      try {
        console.log(`Trying selector: ${selector}`);
        usernameInput = await page.waitForSelector(selector, { timeout: 5000, visible: true });
        if (usernameInput) {
          console.log(`Found username input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        console.log(`Selector ${selector} not found, trying next...`);
      }
    }
    
    if (!usernameInput) {
      throw new Error('Could not find username input field. Twitter may have changed their login page or is showing CAPTCHA.');
    }

    // Enter username
    console.log('Entering username...');
    await usernameInput.type(username, { delay: 100 });
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
    try {
      await page.waitForSelector('input[name="password"]', { timeout: 20000, visible: true });
      await page.type('input[name="password"]', password, { delay: 100 });
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log('Password field not found. Checking page content...');
      const currentUrl = page.url();
      const currentTitle = await page.title();
      console.log('Current URL:', currentUrl);
      console.log('Current title:', currentTitle);
      throw new Error('Password input not found - possible phone verification required');
    }

    // Click Login
    console.log('Clicking Login...');
    await page.click('[data-testid="LoginForm_Login_Button"]');
    await page.waitForTimeout(6000);

    // Wait for home page
    console.log('Waiting for login to complete...');
    try {
      await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 20000 });
      console.log('Login successful!');
    } catch (e) {
      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText);
      console.log('Login failed. Current URL:', currentUrl);
      console.log('Page text snippet:', pageText.substring(0, 500));
      throw new Error('Login failed - could not find Tweet button. Check credentials or account status.');
    }

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