// server.js - Adaptive Twitter Automation with Dynamic Flow Detection
// Handles: username → email → password → OTP in ANY order

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COOKIES_PATH = path.join(__dirname, 'twitter-cookies.json');

// In-memory storage for pending sessions
const pendingSessions = new Map();

// Load/Save cookies
async function loadCookies() {
  try {
    const cookiesString = await fs.readFile(COOKIES_PATH, 'utf8');
    return JSON.parse(cookiesString);
  } catch (error) {
    return null;
  }
}

async function saveCookies(cookies) {
  await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('✅ Cookies saved');
}

// Detect what Twitter is asking for
async function detectCurrentStep(page) {
  const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
  const pageHTML = await page.content();
  
  // Check for different input types
  const hasUsernameInput = await page.$('input[autocomplete="username"]') !== null;
  const hasPasswordInput = await page.$('input[name="password"]') !== null;
  const hasTextInput = await page.$('input[data-testid="ocfEnterTextTextInput"]') !== null;
  const hasEmailPrompt = pageText.includes('email') || pageText.includes('enter your phone');
  const hasOTPPrompt = pageText.includes('verification code') || pageText.includes('we sent you a code');
  const hasCaptcha = pageHTML.includes('captcha') || pageHTML.includes('recaptcha');
  const isLoggedIn = await page.$('[data-testid="SideNav_NewTweet_Button"]') !== null;
  
  // Determine step
  if (isLoggedIn) {
    return { step: 'LOGGED_IN' };
  }
  
  if (hasCaptcha) {
    return { step: 'CAPTCHA', message: 'CAPTCHA detected - cannot proceed automatically' };
  }
  
  if (hasUsernameInput) {
    return { step: 'USERNAME', selector: 'input[autocomplete="username"]' };
  }
  
  if (hasPasswordInput) {
    return { step: 'PASSWORD', selector: 'input[name="password"]' };
  }
  
  if (hasOTPPrompt && hasTextInput) {
    return { step: 'OTP', selector: 'input[data-testid="ocfEnterTextTextInput"]' };
  }
  
  if (hasEmailPrompt && hasTextInput) {
    return { step: 'EMAIL', selector: 'input[data-testid="ocfEnterTextTextInput"]' };
  }
  
  // Unknown state
  return { 
    step: 'UNKNOWN', 
    pageText: pageText.substring(0, 500),
    availableInputs: {
      hasUsernameInput,
      hasPasswordInput,
      hasTextInput,
      hasEmailPrompt,
      hasOTPPrompt
    }
  };
}

// Click Next button
async function clickNext(page) {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
    const nextButton = buttons.find(btn => {
      const text = btn.textContent?.trim().toLowerCase();
      return text === 'next' || text === 'log in' || text === 'login';
    });
    if (nextButton) nextButton.click();
  });
  await page.waitForTimeout(4000);
}

// Fill input field
async function fillInput(page, selector, value) {
  const input = await page.waitForSelector(selector, { timeout: 5000, visible: true });
  await input.click({ clickCount: 3 }); // Select all
  await page.keyboard.press('Backspace'); // Clear
  await input.type(value, { delay: 100 });
  await page.waitForTimeout(1000);
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Twitter Automation Service - Adaptive Login v3.0',
    version: '3.0.0',
    features: ['Dynamic flow detection', 'Multi-step handling', 'Cookie persistence', 'OTP support'],
    endpoints: {
      'POST /login': 'Start adaptive login flow',
      'POST /continue-login': 'Continue login with required data (email/OTP)',
      'POST /post-tweet': 'Post tweet (uses cookies)',
      'GET /check-session': 'Verify cookie validity',
      'DELETE /logout': 'Clear cookies'
    }
  });
});

// Start adaptive login
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
    console.log(`\n[${sessionId}] 🚀 Starting adaptive login...`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
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

    console.log(`[${sessionId}] 🌐 Loading Twitter...`);
    await page.goto('https://twitter.com/i/flow/login', { 
      waitUntil: 'networkidle0',
      timeout: 90000 
    });
    await page.waitForTimeout(3000);

    // Adaptive flow - handle up to 10 steps
    let maxSteps = 10;
    let currentStep = 0;
    const credentials = { username, password, email };
    
    while (currentStep < maxSteps) {
      currentStep++;
      console.log(`\n[${sessionId}] 📍 Step ${currentStep}: Detecting...`);
      
      const detected = await detectCurrentStep(page);
      console.log(`[${sessionId}] ➡️  Detected: ${detected.step}`);
      
      if (detected.step === 'LOGGED_IN') {
        console.log(`[${sessionId}] ✅ Login successful!`);
        const cookies = await page.cookies();
        await saveCookies(cookies);
        await browser.close();
        
        return res.json({
          success: true,
          message: 'Login successful! Cookies saved.',
          steps: currentStep,
          cookiesCount: cookies.length
        });
      }
      
      if (detected.step === 'CAPTCHA') {
        await browser.close();
        return res.status(400).json({
          success: false,
          error: 'CAPTCHA detected',
          message: 'Twitter is showing CAPTCHA. Please login manually in a browser first to verify you\'re human.',
          step: detected.step
        });
      }
      
      if (detected.step === 'USERNAME') {
        console.log(`[${sessionId}] 👤 Entering username...`);
        await fillInput(page, detected.selector, credentials.username);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'PASSWORD') {
        console.log(`[${sessionId}] 🔐 Entering password...`);
        await fillInput(page, detected.selector, credentials.password);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'EMAIL') {
        if (!credentials.email) {
          // Save session for continuation
          pendingSessions.set(sessionId, { browser, page, credentials });
          setTimeout(() => {
            if (pendingSessions.has(sessionId)) {
              pendingSessions.delete(sessionId);
              browser.close();
            }
          }, 300000); // 5 min timeout
          
          return res.json({
            success: false,
            needsEmail: true,
            sessionId: sessionId,
            message: 'Twitter is asking for email verification',
            instruction: 'Use POST /continue-login with: { "sessionId": "' + sessionId + '", "email": "your@email.com" }'
          });
        }
        
        console.log(`[${sessionId}] 📧 Entering email...`);
        await fillInput(page, detected.selector, credentials.email);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'OTP') {
        // Save session for OTP input
        pendingSessions.set(sessionId, { browser, page, credentials });
        setTimeout(() => {
          if (pendingSessions.has(sessionId)) {
            pendingSessions.delete(sessionId);
            browser.close();
          }
        }, 300000);
        
        return res.json({
          success: false,
          needsOTP: true,
          sessionId: sessionId,
          message: 'Twitter sent a verification code to your email/phone',
          instruction: 'Use POST /continue-login with: { "sessionId": "' + sessionId + '", "otp": "123456" }'
        });
      }
      
      if (detected.step === 'UNKNOWN') {
        console.log(`[${sessionId}] ❓ Unknown step detected`);
        console.log('Page text:', detected.pageText);
        
        // Save session in case user can provide solution
        pendingSessions.set(sessionId, { browser, page, credentials });
        setTimeout(() => {
          if (pendingSessions.has(sessionId)) {
            pendingSessions.delete(sessionId);
            browser.close();
          }
        }, 300000);
        
        return res.json({
          success: false,
          needsInput: true,
          sessionId: sessionId,
          unknownStep: true,
          pageText: detected.pageText,
          availableInputs: detected.availableInputs,
          message: 'Twitter is asking for something unexpected',
          instruction: 'Check pageText to see what Twitter is asking for'
        });
      }
      
      // Safety: if we reach here, wait a bit before next iteration
      await page.waitForTimeout(2000);
    }
    
    // Max steps exceeded
    await browser.close();
    return res.status(500).json({
      success: false,
      error: 'Max login steps exceeded',
      message: 'Login process took too many steps. Please try again or login manually.'
    });

  } catch (error) {
    console.error(`[${sessionId}] ❌ Error:`, error.message);
    if (browser) await browser.close();
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Continue login with email/OTP
app.post('/continue-login', async (req, res) => {
  const { sessionId, email, otp } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Missing sessionId'
    });
  }

  const session = pendingSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found or expired'
    });
  }

  const { browser, page, credentials } = session;

  try {
    console.log(`\n[${sessionId}] 🔄 Continuing login...`);
    
    // Update credentials with new data
    if (email) credentials.email = email;
    if (otp) credentials.otp = otp;
    
    // Continue adaptive flow
    let maxSteps = 10;
    let currentStep = 0;
    
    while (currentStep < maxSteps) {
      currentStep++;
      console.log(`\n[${sessionId}] 📍 Step ${currentStep}: Detecting...`);
      
      const detected = await detectCurrentStep(page);
      console.log(`[${sessionId}] ➡️  Detected: ${detected.step}`);
      
      if (detected.step === 'LOGGED_IN') {
        console.log(`[${sessionId}] ✅ Login successful!`);
        const cookies = await page.cookies();
        await saveCookies(cookies);
        pendingSessions.delete(sessionId);
        await browser.close();
        
        return res.json({
          success: true,
          message: 'Login successful! Cookies saved.',
          cookiesCount: cookies.length
        });
      }
      
      if (detected.step === 'EMAIL' && credentials.email) {
        console.log(`[${sessionId}] 📧 Entering email...`);
        await fillInput(page, detected.selector, credentials.email);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'OTP' && credentials.otp) {
        console.log(`[${sessionId}] 🔢 Entering OTP...`);
        await fillInput(page, detected.selector, credentials.otp);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'PASSWORD') {
        console.log(`[${sessionId}] 🔐 Entering password...`);
        await fillInput(page, detected.selector, credentials.password);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'USERNAME') {
        console.log(`[${sessionId}] 👤 Entering username...`);
        await fillInput(page, detected.selector, credentials.username);
        await clickNext(page);
        continue;
      }
      
      if (detected.step === 'EMAIL' && !credentials.email) {
        return res.json({
          success: false,
          needsEmail: true,
          sessionId: sessionId,
          message: 'Still need email - please provide'
        });
      }
      
      if (detected.step === 'OTP' && !credentials.otp) {
        return res.json({
          success: false,
          needsOTP: true,
          sessionId: sessionId,
          message: 'Still need OTP - please provide'
        });
      }
      
      if (detected.step === 'UNKNOWN') {
        return res.json({
          success: false,
          unknownStep: true,
          pageText: detected.pageText,
          message: 'Unexpected page state'
        });
      }
      
      await page.waitForTimeout(2000);
    }
    
    pendingSessions.delete(sessionId);
    await browser.close();
    return res.status(500).json({
      success: false,
      error: 'Max steps exceeded during continuation'
    });

  } catch (error) {
    console.error(`[${sessionId}] ❌ Continuation error:`, error.message);
    pendingSessions.delete(sessionId);
    await browser.close();
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check session validity
app.get('/check-session', async (req, res) => {
  const cookies = await loadCookies();
  
  if (!cookies) {
    return res.json({
      success: false,
      hasSession: false,
      message: 'No saved cookies'
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
    await page.goto('https://twitter.com/home', { 
      waitUntil: 'networkidle0', 
      timeout: 30000 
    });

    const isLoggedIn = await page.$('[data-testid="SideNav_NewTweet_Button"]') !== null;
    await browser.close();

    res.json({
      success: true,
      hasSession: true,
      isValid: isLoggedIn,
      message: isLoggedIn ? 'Session valid ✅' : 'Session expired ❌'
    });

  } catch (error) {
    if (browser) await browser.close();
    res.json({
      success: false,
      error: error.message
    });
  }
});

// Logout
app.delete('/logout', async (req, res) => {
  try {
    await fs.unlink(COOKIES_PATH);
    res.json({ success: true, message: 'Cookies deleted' });
  } catch (error) {
    res.json({ success: true, message: 'No cookies to delete' });
  }
});

// Post tweet with cookies
app.post('/post-tweet', async (req, res) => {
  const { tweetText } = req.body;

  if (!tweetText) {
    return res.status(400).json({
      success: false,
      error: 'Missing tweetText'
    });
  }

  const cookies = await loadCookies();
  if (!cookies) {
    return res.status(401).json({
      success: false,
      error: 'No session - please login first'
    });
  }

  let browser;
  try {
    console.log('📤 Posting tweet with cookies...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setCookie(...cookies);
    
    await page.goto('https://twitter.com/home', { 
      waitUntil: 'networkidle0',
      timeout: 60000 
    });

    const isLoggedIn = await page.$('[data-testid="SideNav_NewTweet_Button"]') !== null;
    if (!isLoggedIn) {
      await browser.close();
      return res.status(401).json({
        success: false,
        error: 'Session expired - please re-login'
      });
    }

    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await page.waitForTimeout(2000);
    
    await page.type('[data-testid="tweetTextarea_0"]', tweetText, { delay: 50 });
    await page.waitForTimeout(2000);
    
    await page.click('[data-testid="tweetButtonInline"]');
    await page.waitForTimeout(4000);

    const finalText = await page.evaluate(() => document.body.innerText);
    const isPosted = finalText.includes('Your post was sent') || 
                    finalText.includes('Your Tweet was sent');

    await browser.close();

    if (isPosted) {
      console.log('✅ Tweet posted!');
      return res.json({
        success: true,
        message: 'Tweet posted successfully',
        tweet: tweetText
      });
    } else {
      return res.status(500).json({
        success: false,
        error: 'Could not confirm post'
      });
    }

  } catch (error) {
    console.error('❌ Post error:', error.message);
    if (browser) await browser.close();
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Twitter Automation Service v3.0`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`✨ Adaptive login with dynamic flow detection\n`);
});