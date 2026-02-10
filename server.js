// server.js - Twitter Automation with Hardcoded Credentials
// Fixed version with stealth mode

const express = require("express");
// CHANGE THESE IMPORTS
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Add stealth plugin
puppeteer.use(StealthPlugin());

const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COOKIES_PATH = process.env.COOKIES_PATH
  ? path.resolve(process.env.COOKIES_PATH)
  : path.join(__dirname, "twitter-cookies.json");

// ============================================
// HARDCODED CREDENTIALS - CHANGE THESE
// ============================================
const TWITTER_USERNAME = process.env.TWITTER_USERNAME || "pratiksha_69";
const TWITTER_PASSWORD = process.env.TWITTER_PASSWORD || "Pratik@2203";
const TWITTER_EMAIL = process.env.TWITTER_EMAIL || "ps15august1947@gmail.com";

// ============================================

// In-memory storage for pending sessions
const pendingSessions = new Map();

function isRailway() {
  return (
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.NODE_ENV === "production"
  );
}

// Load/Save cookies
async function saveCookies(cookies) {
  await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log("✅ Cookies saved to file");

  if (isRailway()) {
    console.log("💾 Cookies also stored in memory");
    process.env.TWITTER_COOKIES_BACKUP = JSON.stringify(cookies);
  }
}

async function loadCookies() {
  try {
    const cookiesString = await fs.readFile(COOKIES_PATH, "utf8");
    return JSON.parse(cookiesString);
  } catch (error) {
    if (isRailway() && process.env.TWITTER_COOKIES_BACKUP) {
      console.log("📂 Loading cookies from backup");
      return JSON.parse(process.env.TWITTER_COOKIES_BACKUP);
    }
    return null;
  }
}

function createBrowser() {
  return puppeteer.launch({
    headless: false,  // or "new" for headless
    executablePath: isRailway()
      ? process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser"
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,1080",
      "--disable-gpu",
      // REMOVE --single-process when headless: false
      // ...(isRailway() ? ["--single-process"] : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: null,  // ADD THIS - prevents viewport issues
    // waitForInitialPage: false,  // Try this if still failing
  });
}

// Improved detection with better selectors
async function detectCurrentStep(page) {
  await page.waitForTimeout(2000);

  try {
    await page.waitForSelector('input, div[role="button"]', { timeout: 5000 });
  } catch (e) {
    console.log("⚠️  No input elements found");
  }

  const pageText = await page.evaluate(() =>
    document.body.innerText.toLowerCase(),
  );
  const pageHTML = await page.content();

  console.log("📄 Page text preview:", pageText.substring(0, 200));

  // Get page heading to understand context
  const pageHeading = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const heading = document.querySelector('[role="heading"]');
    return (h1?.innerText || heading?.innerText || "").toLowerCase();
  });

  console.log("📋 Page heading:", pageHeading);

  // Check for different input types
  const hasUsernameInput = await page.evaluate(() => {
    const byAutocomplete = document.querySelector(
      'input[autocomplete="username"]',
    );
    const byName = document.querySelector('input[name="text"]');
    const byPlaceholder = Array.from(document.querySelectorAll("input")).find(
      (inp) =>
        inp.placeholder?.toLowerCase().includes("phone") ||
        inp.placeholder?.toLowerCase().includes("email") ||
        inp.placeholder?.toLowerCase().includes("username"),
    );
    return !!(byAutocomplete || byName || byPlaceholder);
  });

  const hasPasswordInput = await page.evaluate(() => {
    return (
      !!document.querySelector('input[name="password"]') ||
      !!document.querySelector('input[type="password"]')
    );
  });

  const hasTextInput = await page.evaluate(() => {
    return !!document.querySelector(
      'input[data-testid="ocfEnterTextTextInput"]',
    );
  });

  // IMPROVED EMAIL DETECTION - Check page heading and content
  const hasEmailPrompt =
    pageText.includes("enter your phone number or email") ||
    pageText.includes("enter your phone") ||
    pageText.includes("unusual login activity") ||
    pageText.includes("verify it's you") ||
    pageHeading.includes("phone") ||
    pageHeading.includes("email");

  const hasOTPPrompt =
    pageText.includes("verification code") ||
    pageText.includes("we sent you a code") ||
    pageText.includes("enter the code") ||
    pageText.includes("check your email") ||
    pageHeading.includes("verification");

  const hasCaptcha =
    pageHTML.includes("captcha") || pageHTML.includes("recaptcha");
  const isLoggedIn =
    (await page.$('[data-testid="SideNav_NewTweet_Button"]')) !== null;

  console.log("🔍 Detection results:", {
    hasUsernameInput,
    hasPasswordInput,
    hasTextInput,
    hasEmailPrompt,
    hasOTPPrompt,
    pageHeading,
    hasCaptcha,
    isLoggedIn,
  });

  // Determine step with PROPER PRIORITY
  if (isLoggedIn) {
    return { step: "LOGGED_IN" };
  }

  if (hasCaptcha) {
    return {
      step: "CAPTCHA",
      message: "CAPTCHA detected - cannot proceed automatically",
    };
  }

  // CHECK PASSWORD FIRST (most specific)
  if (hasPasswordInput) {
    return {
      step: "PASSWORD",
      selector: 'input[name="password"], input[type="password"]',
    };
  }

  // CHECK OTP (specific input type)
  if (hasOTPPrompt && hasTextInput) {
    return {
      step: "OTP",
      selector: 'input[data-testid="ocfEnterTextTextInput"]',
    };
  }

  // CHECK EMAIL VERIFICATION (before generic username)
  // This is the KEY FIX - prioritize email when unusual login is detected
  if (hasEmailPrompt && (hasTextInput || hasUsernameInput)) {
    const selector = await page.evaluate(() => {
      // Try specific email input first
      const emailInput = document.querySelector(
        'input[data-testid="ocfEnterTextTextInput"]',
      );
      if (emailInput) return 'input[data-testid="ocfEnterTextTextInput"]';

      // Otherwise use text input
      const textInput = document.querySelector('input[name="text"]');
      if (textInput) return 'input[name="text"]';

      return "input";
    });

    return {
      step: "EMAIL",
      selector: selector,
    };
  }

  // ONLY THEN check for initial username input
  if (hasUsernameInput && !hasEmailPrompt) {
    const selector = await page.evaluate(() => {
      const byAutocomplete = document.querySelector(
        'input[autocomplete="username"]',
      );
      if (byAutocomplete) return 'input[autocomplete="username"]';

      const byName = document.querySelector('input[name="text"]');
      if (byName) return 'input[name="text"]';

      return "input";
    });

    return { step: "USERNAME", selector };
  }

  // Unknown state
  return {
    step: "UNKNOWN",
    pageText: pageText.substring(0, 500),
    pageHeading: pageHeading,
    pageHTML: pageHTML.substring(0, 1000),
    availableInputs: {
      hasUsernameInput,
      hasPasswordInput,
      hasTextInput,
      hasEmailPrompt,
      hasOTPPrompt,
    },
  };
}

// Add this function right after detectCurrentStep()
async function verifyInputHasValue(page, selector) {
  const value = await page.evaluate((sel) => {
    const input = document.querySelector(sel);
    return input ? input.value : "";
  }, selector);
  console.log(`   📝 Input value: "${value}" (length: ${value.length})`);
  return value.length > 0;
}

// REPLACE the fillInputAndProceed function with this improved version:
async function fillInputAndProceed(page, selector, value, fieldName = "field") {
  console.log(`   ⌨️  Typing ${fieldName}...`);

  // Find the input - try multiple selectors if first fails
  let input;
  try {
    input = await page.waitForSelector(selector, {
      timeout: 10000,
      visible: true,
    });
  } catch (error) {
    console.log(`   ❌ Could not find selector: ${selector}`);
    // Try alternative selectors
    const altSelectors = [
      'input[name="text"]',
      'input[autocomplete="username"]',
      'input[type="text"]',
    ];

    for (const altSel of altSelectors) {
      try {
        console.log(`   🔄 Trying alternative: ${altSel}`);
        input = await page.waitForSelector(altSel, {
          timeout: 3000,
          visible: true,
        });
        if (input) {
          console.log(`   ✅ Found input with: ${altSel}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!input) {
      throw new Error("Could not find any input field!");
    }
  }

  // Clear and type with verification
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(500);

  // Type character by character and verify
  console.log(`   📝 Typing: "${value}"`);
  await input.type(value, { delay: 100 });
  await page.waitForTimeout(1000);

  // VERIFY text was entered
  const hasValue = await verifyInputHasValue(page, selector);
  if (!hasValue) {
    console.log(`   ⚠️  WARNING: Input appears empty after typing!`);
    // Try one more time
    await input.click();
    await page.keyboard.type(value, { delay: 120 });
    await page.waitForTimeout(1000);
    const hasValueRetry = await verifyInputHasValue(page, selector);
    if (!hasValueRetry) {
      throw new Error("Failed to enter text into input field!");
    }
  }

  // Get page state before clicking
  const pageTextBefore = await page.evaluate(() => document.body.innerText);

  console.log(`   🖱️  Clicking Next button...`);

  // Click Next button with better detection
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('div[role="button"], button, span'),
    );

    // Try to find Next button by text
    let nextButton = buttons.find((btn) => {
      const text = btn.textContent?.trim().toLowerCase();
      return text === "next" || text === "log in" || text === "login";
    });

    // If not found, try by looking for parent div
    if (!nextButton) {
      nextButton = Array.from(
        document.querySelectorAll('div[role="button"]'),
      ).find((div) => {
        return div.querySelector("span")?.textContent?.toLowerCase() === "next";
      });
    }

    if (nextButton) {
      console.log("Found button:", nextButton.textContent);
      nextButton.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    console.log("   ⚠️  Could not find Next button!");
    throw new Error("Next button not found!");
  }

  console.log(`   ⏳ Waiting for page to change...`);

  // Wait for page content to actually change
  let pageChanged = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const pageTextAfter = await page.evaluate(() => document.body.innerText);

    if (pageTextAfter !== pageTextBefore) {
      console.log(`   ✓ Page changed after ${i + 1} seconds`);
      pageChanged = true;
      break;
    }
  }

  if (!pageChanged) {
    console.log(`   ⚠️  WARNING: Page content did not change!`);
    // Take debug screenshot
    if (process.env.NODE_ENV !== "production") {
      await page.screenshot({ path: `debug-step-${currentStep}.png` });
    }
  }

  await page.waitForTimeout(2000);
  console.log(`   ✓ Transition complete`);
}

// Helper function - add after your other functions
async function humanDelay(min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Twitter Automation Service - Fixed v4.0",
    version: "4.0.0",
    credentials: {
      username:
        TWITTER_USERNAME !== "your_username_here" ? "✅ Set" : "❌ Not set",
      password:
        TWITTER_PASSWORD !== "your_password_here" ? "✅ Set" : "❌ Not set",
      email: TWITTER_EMAIL !== "your_email_here" ? "✅ Set" : "❌ Not set",
    },
    features: [
      "Hardcoded credentials",
      "Improved page detection",
      "Proper wait mechanisms",
      "OTP support via continue-login",
    ],
    endpoints: {
      "POST /login": "Start login (uses hardcoded credentials)",
      "POST /continue-login": "Continue with OTP: { sessionId, otp }",
      "POST /post-tweet": "Post tweet: { tweetText }",
      "GET /check-session": "Verify cookie validity",
      "DELETE /logout": "Clear cookies",
    },
  });
});

// Start login with hardcoded credentials
app.post("/login", async (req, res) => {
  // Use hardcoded credentials
  const username = TWITTER_USERNAME;
  const password = TWITTER_PASSWORD;
  const email = TWITTER_EMAIL;

  if (username === "your_username_here" || password === "your_password_here") {
    return res.status(400).json({
      success: false,
      error: "Please set hardcoded credentials in server.js",
      message:
        "Edit TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL at the top of server.js",
    });
  }

  let browser;
  const sessionId = Date.now().toString();

  try {
    console.log(
      `\n[${sessionId}] 🚀 Starting login with hardcoded credentials...`,
    );
    console.log(`[${sessionId}] 👤 Username: ${username}`);
    console.log(`[${sessionId}] 📧 Email: ${email}`);

    // Use this in ALL your launch() calls
    browser = await createBrowser();

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    console.log(`[${sessionId}] 🌐 Loading Twitter login page...`);
    await page.goto("https://twitter.com/i/flow/login", {
      waitUntil: "networkidle0",
      timeout: 90000,
    });

    console.log(`[${sessionId}] ⏳ Waiting for login form...`);
    await page.waitForSelector("input", { timeout: 15000 });
    await page.waitForTimeout(3000);

    // Adaptive flow
    let maxSteps = 10;
    let currentStep = 0;
    const credentials = { username, password, email };

    while (currentStep < maxSteps) {
      currentStep++;
      console.log(`\n[${sessionId}] 📍 Step ${currentStep}: Detecting...`);

      const detected = await detectCurrentStep(page);
      console.log(`[${sessionId}] ➡️  Detected: ${detected.step}`);

      // Take screenshot for debugging
      if (process.env.NODE_ENV !== "production") {
        await page.screenshot({ path: `debug-step-${currentStep}.png` });
        console.log(
          `[${sessionId}] 📸 Screenshot: debug-step-${currentStep}.png`,
        );
      }

      if (detected.step === "LOGGED_IN") {
        console.log(`[${sessionId}] ✅ Login successful!`);
        const cookies = await page.cookies();
        await saveCookies(cookies);
        await browser.close();

        return res.json({
          success: true,
          message: "🎉 Login successful! Cookies saved.",
          sessionId: sessionId,
          steps: currentStep,
          cookiesCount: cookies.length,
          username: username,
        });
      }

      if (detected.step === "CAPTCHA") {
        await browser.close();
        return res.status(400).json({
          success: false,
          error: "CAPTCHA detected",
          message:
            "Twitter is showing CAPTCHA. Please login manually in browser first.",
          step: detected.step,
        });
      }

      if (detected.step === "USERNAME") {
        console.log(`[${sessionId}] 👤 Entering username...`);
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.username,
          "username",
        );
        continue;
      }

      if (detected.step === "PASSWORD") {
        console.log(`[${sessionId}] 🔐 Entering password...`);
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.password,
          "password",
        );
        continue;
      }

      if (detected.step === "EMAIL") {
        console.log(`[${sessionId}] 📧 Entering email verification...`);
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.email,
          "email",
        );
        continue;
      }

      if (detected.step === "OTP") {
        console.log(`[${sessionId}] 🔢 OTP required - pausing for user input`);

        // Save session for OTP input
        pendingSessions.set(sessionId, { browser, page, credentials });
        setTimeout(() => {
          if (pendingSessions.has(sessionId)) {
            console.log(`[${sessionId}] ⏱️  Session expired (5 min timeout)`);
            pendingSessions.delete(sessionId);
            browser.close();
          }
        }, 300000);

        return res.json({
          success: false,
          needsOTP: true,
          sessionId: sessionId,
          message: "📱 Twitter sent a verification code",
          instruction:
            'Call POST /continue-login with { "sessionId": "' +
            sessionId +
            '", "otp": "123456" }',
          nextStep: "/continue-login",
        });
      }

      if (detected.step === "UNKNOWN") {
        console.log(`[${sessionId}] ❓ Unknown page state`);
        console.log("Page text:", detected.pageText);

        // Save session for debugging
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
          pageHTMLPreview: detected.pageHTML,
          availableInputs: detected.availableInputs,
          message: "⚠️  Twitter is asking for something unexpected",
          instruction: "Check pageText and pageHTMLPreview to debug",
        });
      }

      await page.waitForTimeout(2000);
    }

    // Max steps exceeded
    await browser.close();
    return res.status(500).json({
      success: false,
      error: "Max login steps exceeded",
      message:
        "Login took too many steps. Please try manual login or check credentials.",
    });
  } catch (error) {
    console.error(`[${sessionId}] ❌ Error:`, error.message);
    if (browser) await browser.close();

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

// Continue login with OTP
app.post("/continue-login", async (req, res) => {
  const { sessionId, otp } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "Missing sessionId",
      message: 'Provide: { "sessionId": "xxx", "otp": "123456" }',
    });
  }

  if (!otp) {
    return res.status(400).json({
      success: false,
      error: "Missing otp",
      message: 'Provide: { "sessionId": "' + sessionId + '", "otp": "123456" }',
    });
  }

  const session = pendingSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Session not found or expired",
      message:
        "Session may have timed out (5 min limit). Please start new login.",
    });
  }

  const { browser, page, credentials } = session;

  try {
    console.log(`\n[${sessionId}] 🔄 Continuing with OTP: ${otp}`);
    credentials.otp = otp;

    let maxSteps = 10;
    let currentStep = 0;

    while (currentStep < maxSteps) {
      currentStep++;
      console.log(
        `\n[${sessionId}] 📍 Continue Step ${currentStep}: Detecting...`,
      );

      const detected = await detectCurrentStep(page);
      console.log(`[${sessionId}] ➡️  Detected: ${detected.step}`);

      if (detected.step === "LOGGED_IN") {
        console.log(`[${sessionId}] ✅ Login successful after OTP!`);
        const cookies = await page.cookies();
        await saveCookies(cookies);
        pendingSessions.delete(sessionId);
        await browser.close();

        return res.json({
          success: true,
          message: "🎉 Login successful with OTP! Cookies saved.",
          sessionId: sessionId,
          cookiesCount: cookies.length,
        });
      }

      if (detected.step === "OTP" && credentials.otp) {
        console.log(`[${sessionId}] 🔢 Entering OTP...`);
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.otp,
          "OTP",
        );
        continue;
      }

      if (detected.step === "PASSWORD") {
        console.log(`[${sessionId}] 🔐 Re-entering password...`);
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.password,
          "password",
        );
        continue;
      }

      if (detected.step === "EMAIL") {
        console.log(`[${sessionId}] 📧 Re-entering email...`);
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.email,
          "email",
        );
        continue;
      }

      if (detected.step === "UNKNOWN") {
        return res.json({
          success: false,
          unknownStep: true,
          pageText: detected.pageText,
          message: "⚠️  Unexpected page state after OTP",
        });
      }

      await page.waitForTimeout(2000);
    }

    pendingSessions.delete(sessionId);
    await browser.close();
    return res.status(500).json({
      success: false,
      error: "Max steps exceeded during OTP continuation",
    });
  } catch (error) {
    console.error(`[${sessionId}] ❌ OTP continuation error:`, error.message);
    pendingSessions.delete(sessionId);
    await browser.close();

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Check session validity
app.get("/check-session", async (req, res) => {
  const cookies = await loadCookies();

  if (!cookies) {
    return res.json({
      success: false,
      hasSession: false,
      message: "No saved cookies. Please login first.",
    });
  }

  let browser;
  try {
    // Use this in ALL your launch() calls
    browser = await createBrowser();

    const page = await browser.newPage();
    await page.setCookie(...cookies);

    // FIXED: Use domcontentloaded
    try {
      await page.goto("https://twitter.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (navError) {
      // Timeout but continue
    }

    await page.waitForTimeout(3000);

    const isLoggedIn =
      (await page.$('[data-testid="SideNav_NewTweet_Button"]')) !== null;
    await browser.close();

    res.json({
      success: true,
      hasSession: true,
      isValid: isLoggedIn,
      message: isLoggedIn
        ? "✅ Session valid"
        : "❌ Session expired - please re-login",
      cookiesCount: cookies.length,
    });
  } catch (error) {
    if (browser) await browser.close();
    res.json({
      success: false,
      error: error.message,
    });
  }
});

// Logout
app.delete("/logout", async (req, res) => {
  try {
    await fs.unlink(COOKIES_PATH);
    res.json({
      success: true,
      message: "✅ Cookies deleted successfully",
    });
  } catch (error) {
    res.json({
      success: true,
      message: "No cookies to delete",
    });
  }
});

// Post tweet with cookies
app.post("/post-tweet", async (req, res) => {
  const { tweetText } = req.body;

  if (!tweetText) {
    return res.status(400).json({
      success: false,
      error: "Missing tweetText",
      message: 'Provide: { "tweetText": "Your tweet here" }',
    });
  }

  const cookies = await loadCookies();
  if (!cookies) {
    return res.status(401).json({
      success: false,
      error: "No session found",
      message: "Please login first using POST /login",
    });
  }

  let browser;
  try {
    console.log("\n📤 === POSTING TWEET ===");
    console.log("Tweet:", tweetText);

    // Use this in ALL your launch() calls
    browser = await createBrowser();

    const page = await browser.newPage();
    await page.setCookie(...cookies);

    console.log("🌐 Loading Twitter home...");
    await page.goto("https://twitter.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(5000); // Wait for full page load

    console.log("🔍 Checking login status...");
    const tweetButton = await page.$('[data-testid="SideNav_NewTweet_Button"]');

    if (!tweetButton) {
      await browser.close();
      return res.status(401).json({
        success: false,
        error: "Session expired",
        message: "Please re-login using POST /login",
      });
    }

    console.log("✅ Logged in!");
    console.log("🖱️  Clicking 'Post' button...");
    await tweetButton.click();
    await humanDelay(1000, 2000);

    // Wait for compose modal to appear
    console.log("⏳ Waiting for compose dialog...");
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', {
      visible: true,
      timeout: 10000,
    });

    console.log("⌨️  Typing tweet text...");
    const textarea = await page.$('[data-testid="tweetTextarea_0"]');

    if (!textarea) {
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Could not find tweet textarea",
      });
    }

    // Focus and type
    await textarea.click();
    await humanDelay(1000, 2000);
    await page.keyboard.type(tweetText, { delay: 50 });
    await humanDelay(1000, 2000);

    // Verify text was entered
    const enteredText = await page.evaluate(() => {
      const textbox = document.querySelector('[data-testid="tweetTextarea_0"]');
      return textbox ? textbox.textContent : "";
    });

    console.log(`📝 Text entered: "${enteredText}"`);

    if (enteredText !== tweetText) {
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Text entry failed",
        expected: tweetText,
        actual: enteredText,
      });
    }

    // Find and click Post button
    console.log("📤 Clicking 'Post' button...");
    const postButton = await page.$('[data-testid="tweetButton"]');

    if (!postButton) {
      console.log("⚠️  'tweetButton' not found, trying 'tweetButtonInline'...");
      const postButtonAlt = await page.$('[data-testid="tweetButtonInline"]');

      if (!postButtonAlt) {
        await browser.close();
        return res.status(500).json({
          success: false,
          error: "Could not find Post button",
        });
      }

      await postButtonAlt.click();
    } else {
      await postButton.click();
    }

    console.log("⏳ Waiting for post confirmation...");
    await page.waitForTimeout(6000);

    // Check multiple success indicators
    const pageContent = await page.evaluate(() =>
      document.body.innerText.toLowerCase(),
    );

    const successIndicators = [
      "your post was sent",
      "your tweet was sent",
      "your post is live",
      "post sent",
    ];

    const isPosted = successIndicators.some((indicator) =>
      pageContent.includes(indicator),
    );

    // Also check if compose modal closed (another success indicator)
    const modalStillOpen =
      (await page.$('[data-testid="tweetTextarea_0"]')) !== null;

    await browser.close();

    if (isPosted || !modalStillOpen) {
      console.log("✅ Tweet posted successfully!");
      return res.json({
        success: true,
        message: "✅ Tweet posted successfully!",
        tweet: tweetText,
        verification: isPosted
          ? "Confirmation message detected"
          : "Modal closed (success)",
      });
    } else {
      console.log("❌ Tweet posting failed");
      console.log("Page content:", pageContent.substring(0, 500));

      return res.status(500).json({
        success: false,
        error: "Tweet posting failed",
        message: "No confirmation detected and modal still open",
        debugInfo: pageContent.substring(0, 300),
      });
    }
  } catch (error) {
    console.error("❌ Post error:", error.message);
    if (browser) await browser.close();

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

app.listen(PORT, () => {
  console.log("\n🚀 Twitter Automation Service v4.0 (Fixed)");
  console.log(`📡 Running on http://localhost:${PORT}`);
  console.log(
    "✨ Features: Hardcoded credentials, improved detection, OTP support\n",
  );
  console.log("⚙️  Credentials status:");
  console.log(
    `   Username: ${TWITTER_USERNAME !== "your_username_here" ? "✅ Set" : "❌ Not set"}`,
  );
  console.log(
    `   Password: ${TWITTER_PASSWORD !== "your_password_here" ? "✅ Set" : "❌ Not set"}`,
  );
  console.log(
    `   Email: ${TWITTER_EMAIL !== "your_email_here" ? "✅ Set" : "❌ Not set"}\n`,
  );
});
