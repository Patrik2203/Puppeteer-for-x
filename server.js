// server.js - Advanced Twitter Automation with Cookie Management & OTP Support

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COOKIES_PATH = path.join(__dirname, 'twitter-cookies.json');

// In-memory storage for pending OTP sessions
const pendingOTPSessions = new Map();

// Load cookies from file
async function loadCookies() {
  try {
    const cookiesString = await fs.readFile(COOKIES_PATH, 'utf8');
    return JSON.parse(cookiesString);
  } catch (error) {
    console.log('No saved cookies found');
    return null;
  }
}

// Save cookies to file
async function saveCookies(cookies) {
  await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('Cookies saved successfully');
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Twitter Puppeteer Service with Cookie Management',
    version: '2.0.0',
    endpoints: {
      'GET /': 'Health check',
      'GET /debug-twitter': 'Debug Twitter page loading',
      'POST /login': 'Interactive login (handles email/OTP verification)',
      'POST /provide-otp': 'Provide OTP code for pending session',
      'POST /post-tweet': 'Post tweet (uses saved cookies)',
      'GET /check-session': 'Check if cookies are valid',
      'DELETE /logout': 'Clear saved cookies'
    }
  });
});

// Debug endpoint
app.get('/debug-twitter', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle0',
      timeout: 90000 
    });
    
    const title = await page.title();
    const url = page.url();
    const content = await page.content();
    
    await browser.close();
    
    res.json({
      success: true,
      pageTitle: title,
      pageUrl: url,
      hasUsernameField: content.includes('autocomplete="username"'),
      contentLength: content.length
    });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});

// Interactive login with email/OTP support
app.post('/login', async (req, res) => {
  const { username, password, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: username, password' 
    });
  }

  let browser;
  const sessionId = Date.now().toString();
  
  try {
    console.log(`[${sessionId}] Starting login process...`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    console.log(`[${sessionId}] Navigating to Twitter login...`);
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle0',
      timeout: 90000 
    });
    await page.waitForTimeout(3000);

    // STEP 1: Enter username
    console.log(`[${sessionId}] Entering username...`);
    const usernameSelectors = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"]'
    ];
    
    let usernameInput;
    for (const selector of usernameSelectors) {
      try {
        usernameInput = await page.waitForSelector(selector, { timeout: 5000, visible: true });
        if (usernameInput) break;
      } catch (e) {}
    }
    
    if (!usernameInput) {
      throw new Error('Username input not found');
    }
    
    await usernameInput.type(username, { delay: 100 });
    await page.waitForTimeout(1000);

    // Click Next
    console.log(`[${sessionId}] Clicking Next...`);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      const nextButton = buttons.find(btn => btn.textContent && btn.textContent.trim() === 'Next');
      if (nextButton) nextButton.click();
    });
    await page.waitForTimeout(4000);

    // STEP 2: Check what Twitter is asking for
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log(`[${sessionId}] Checking page content...`);

    // Case 1: Email verification
    if (pageText.includes('Enter your email') || pageText.includes('Enter your phone number')) {
      console.log(`[${sessionId}] Email/phone verification detected`);
      
      if (!email) {
        await browser.close();
        return res.status(400).json({
          success: false,
          requiresEmail: true,
          message: 'Twitter is asking for email verification. Please provide email in the request body.'
        });
      }

      const emailInput = await page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', { timeout: 5000 });
      await emailInput.type(email, { delay: 100 });
      await page.waitForTimeout(1000);

      // Click Next
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
        const nextButton = buttons.find(btn => btn.textContent && btn.textContent.trim() === 'Next');
        if (nextButton) nextButton.click();
      });
      await page.waitForTimeout(4000);
    }

    // STEP 3: Check for OTP request
    const pageText2 = await page.evaluate(() => document.body.innerText);
    
    if (pageText2.includes('verification code') || pageText2.includes('Enter the code')) {
      console.log(`[${sessionId}] OTP verification detected - waiting for code...`);
      
      // Store session for OTP input
      pendingOTPSessions.set(sessionId, { browser, page, username, password });
      
      // Set timeout to clean up after 5 minutes
      setTimeout(() => {
        if (pendingOTPSessions.has(sessionId)) {
          console.log(`[${sessionId}] Session timeout - cleaning up`);
          pendingOTPSessions.delete(sessionId);
          browser.close();
        }
      }, 300000);
      
      return res.json({
        success: false,
        requiresOTP: true,
        sessionId: sessionId,
        message: 'Twitter sent OTP to your email/phone. Use POST /provide-otp with sessionId and otp code.',
        nextStep: `POST /provide-otp with body: { "sessionId": "${sessionId}", "otp": "YOUR_CODE" }`
      });
    }

    // STEP 4: Enter password
    console.log(`[${sessionId}] Entering password...`);
    
    const passwordInput = await page.waitForSelector('input[name="password"]', { timeout: 10000, visible: true });
    await passwordInput.type(password, { delay: 100 });
    await page.waitForTimeout(1000);

    // Click Login
    console.log(`[${sessionId}] Clicking Login...`);
    await page.click('[data-testid="LoginForm_Login_Button"]');
    await page.waitForTimeout(6000);

    // STEP 5: Verify login success
    console.log(`[${sessionId}] Verifying login...`);
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[data-testid="SideNav_NewTweet_Button"]') !== null;
    });

    if (!isLoggedIn) {
      const currentUrl = page.url();
      const errorText = await page.evaluate(() => document.body.innerText);
      await browser.close();
      return res.status(401).json({
        success: false,
        error: 'Login failed - check credentials',
        currentUrl,
        pageText: errorText.substring(0, 500)
      });
    }

    // STEP 6: Save cookies
    console.log(`[${sessionId}] Login successful! Saving cookies...`);
    const cookies = await page.cookies();
    await saveCookies(cookies);

    await browser.close();

    res.json({
      success: true,
      message: 'Login successful! Cookies saved. You can now use /post-tweet endpoint.',
      cookiesCount: cookies.length
    });

  } catch (error) {
    console.error(`[${sessionId}] Login error:`, error.message);
    if (browser) await browser.close();
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Provide OTP for pending session
app.post('/provide-otp', async (req, res) => {
  const { sessionId, otp } = req.body;

  if (!sessionId || !otp) {
    return res.status(400).json({
      success: false,
      error: 'Missing sessionId or otp'
    });
  }

  const session = pendingOTPSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found or expired. Please login again.'
    });
  }

  const { browser, page, password } = session;

  try {
    console.log(`[${sessionId}] Entering OTP: ${otp}`);
    
    // Enter OTP
    const otpInput = await page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', { timeout: 5000 });
    await otpInput.type(otp, { delay: 100 });
    await page.waitForTimeout(1000);

    // Click Next
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      const nextButton = buttons.find(btn => btn.textContent && btn.textContent.trim() === 'Next');
      if (nextButton) nextButton.click();
    });
    await page.waitForTimeout(4000);

    // Check if password is now required
    const pageText = await page.evaluate(() => document.body.innerText);
    
    if (pageText.includes('password') || pageText.includes('Password')) {
      console.log(`[${sessionId}] Entering password after OTP...`);
      
      const passwordInput = await page.waitForSelector('input[name="password"]', { timeout: 10000 });
      await passwordInput.type(password, { delay: 100 });
      await page.waitForTimeout(1000);

      await page.click('[data-testid="LoginForm_Login_Button"]');
      await page.waitForTimeout(6000);
    }

    // Verify login
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[data-testid="SideNav_NewTweet_Button"]') !== null;
    });

    if (!isLoggedIn) {
      throw new Error('Login failed after OTP');
    }

    console.log(`[${sessionId}] Login successful! Saving cookies...`);
    const cookies = await page.cookies();
    await saveCookies(cookies);

    // Clean up
    pendingOTPSessions.delete(sessionId);
    await browser.close();

    res.json({
      success: true,
      message: 'OTP verified and login successful! Cookies saved.',
      cookiesCount: cookies.length
    });

  } catch (error) {
    console.error(`[${sessionId}] OTP verification error:`, error.message);
    pendingOTPSessions.delete(sessionId);
    await browser.close();
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check if session is valid
app.get('/check-session', async (req, res) => {
  const cookies = await loadCookies();
  
  if (!cookies) {
    return res.json({
      success: false,
      hasSession: false,
      message: 'No saved cookies found. Please login first.'
    });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setCookie(...cookies);
    await page.goto('https://twitter.com/home', { waitUntil: 'networkidle0', timeout: 30000 });

    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[data-testid="SideNav_NewTweet_Button"]') !== null;
    });

    await browser.close();

    res.json({
      success: true,
      hasSession: true,
      isValid: isLoggedIn,
      message: isLoggedIn ? 'Session is valid' : 'Session expired - please login again'
    });

  } catch (error) {
    if (browser) await browser.close();
    res.json({
      success: false,
      hasSession: true,
      isValid: false,
      error: error.message
    });
  }
});

// Logout - clear cookies
app.delete('/logout', async (req, res) => {
  try {
    await fs.unlink(COOKIES_PATH);
    res.json({
      success: true,
      message: 'Cookies deleted successfully'
    });
  } catch (error) {
    res.json({
      success: true,
      message: 'No cookies to delete'
    });
  }
});

// Post tweet using saved cookies
app.post('/post-tweet', async (req, res) => {
  const { tweetText } = req.body;

  if (!tweetText) {
    return res.status(400).json({
      success: false,
      error: 'Missing tweetText in request body'
    });
  }

  const cookies = await loadCookies();
  
  if (!cookies) {
    return res.status(401).json({
      success: false,
      error: 'No session found. Please login first using POST /login'
    });
  }

  let browser;
  
  try {
    console.log('Posting tweet with saved cookies...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Load cookies
    await page.setCookie(...cookies);
    
    // Go directly to home page
    console.log('Loading Twitter home...');
    await page.goto('https://twitter.com/home', { 
      waitUntil: 'networkidle0',
      timeout: 60000 
    });
    await page.waitForTimeout(3000);

    // Check if still logged in
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[data-testid="SideNav_NewTweet_Button"]') !== null;
    });

    if (!isLoggedIn) {
      await browser.close();
      return res.status(401).json({
        success: false,
        error: 'Session expired. Please login again using POST /login'
      });
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

    await browser.close();

    if (isPosted) {
      console.log('Tweet posted successfully!');
      return res.json({
        success: true,
        message: 'Tweet posted successfully',
        tweet: tweetText
      });
    } else {
      return res.status(500).json({
        success: false,
        error: 'Could not confirm tweet was posted'
      });
    }

  } catch (error) {
    console.error('Post tweet error:', error);
    if (browser) await browser.close();
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Twitter Puppeteer Service v2.0 running on port ${PORT}`);
  console.log('Cookie-based authentication enabled');
});