// ============================================
// x Automation Service v5.0
// Production-Ready with Manual + Auto Login
// ============================================

const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const IS_DEBUG = process.env.DEBUG === "true" || !IS_PRODUCTION;

const COOKIES_PATH = process.env.COOKIES_PATH
  ? path.resolve(process.env.COOKIES_PATH)
  : path.join(__dirname, "x-cookies.json");

// Credentials (prefer environment variables)
const x_USERNAME = process.env.x_USERNAME || "your_username_here";
const x_PASSWORD = process.env.x_PASSWORD || "your_password_here@";
const x_EMAIL = process.env.x_EMAIL || "your_email_here";

// ============================================
// HELPERS
// ============================================
const pendingSessions = new Map();

function isRailway() {
  return process.env.RAILWAY_ENVIRONMENT !== undefined || IS_PRODUCTION;
}

function log(sessionId, message, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}][${sessionId}] ${message}`, ...args);
}

// ============================================
// COOKIE MANAGEMENT (FIXED)
// ============================================

/**
 * Save cookies with proper formatting
 * Converts Puppeteer cookie format to standard format
 */
async function saveCookies(puppeteerCookies) {
  // Transform Puppeteer cookies to proper format
  const formattedCookies = puppeteerCookies.map((cookie) => {
    // Puppeteer returns cookies with slightly different property names
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      // Convert expires: Puppeteer uses unix timestamp, we want it too
      expires: cookie.expires || Date.now() / 1000 + 31536000, // 1 year if not set
      httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : false,
      secure: cookie.secure !== undefined ? cookie.secure : true,
      sameSite: cookie.sameSite || "None",
    };
  });

  // Save to file
  await fs.writeFile(COOKIES_PATH, JSON.stringify(formattedCookies, null, 2));

  console.log("✅ Cookies saved to file:");
  console.log(`   📂 Path: ${COOKIES_PATH}`);
  console.log(`   🍪 Count: ${formattedCookies.length} cookies`);

  // Log important cookies
  const authToken = formattedCookies.find((c) => c.name === "auth_token");
  const ct0 = formattedCookies.find((c) => c.name === "ct0");
  const twid = formattedCookies.find((c) => c.name === "twid");

  console.log(`   🔑 Critical cookies:`);
  console.log(`      auth_token: ${authToken ? "✅ Found" : "❌ Missing"}`);
  console.log(`      ct0: ${ct0 ? "✅ Found" : "❌ Missing"}`);
  console.log(`      twid: ${twid ? "✅ Found" : "❌ Missing"}`);

  // Also backup in environment for Railway
  if (isRailway()) {
    process.env.X_COOKIES_BACKUP = JSON.stringify(formattedCookies);
    console.log("💾 Cookies backed up to memory");
  }

  return formattedCookies;
}

/**
 * Load cookies from various sources
 */
async function loadCookies() {
  // Priority 1: Environment variable (Railway)
  if (process.env.X_COOKIES) {
    console.log("📂 Loading cookies from X_COOKIES env");
    try {
      return JSON.parse(process.env.X_COOKIES);
    } catch (e) {
      console.log("⚠️  Failed to parse X_COOKIES env");
    }
  }

  // Priority 2: Backup in memory (Railway fallback)
  if (isRailway() && process.env.X_COOKIES_BACKUP) {
    console.log("📂 Loading cookies from memory backup");
    try {
      return JSON.parse(process.env.X_COOKIES_BACKUP);
    } catch (e) {
      console.log("⚠️  Failed to parse backup cookies");
    }
  }

  // Priority 3: File system
  try {
    const cookiesString = await fs.readFile(COOKIES_PATH, "utf8");
    console.log("📂 Loading cookies from file");
    const cookies = JSON.parse(cookiesString);

    // Verify format
    if (!Array.isArray(cookies) || cookies.length === 0) {
      console.log("⚠️  Cookies file is empty or invalid");
      return null;
    }

    return cookies;
  } catch (error) {
    console.log(`⚠️  Could not load cookies: ${error.message}`);
    return null;
  }
}

/**
 * Apply cookies to a Puppeteer page
 * Converts our format back to Puppeteer format
 */
async function applyCookies(page, cookies) {
  if (!cookies || cookies.length === 0) {
    return false;
  }

  // Navigate to domain first (required for setting cookies)
  await page.goto("https://x.com", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // Convert our format to Puppeteer format and set cookies
  for (const cookie of cookies) {
    try {
      // Puppeteer's setCookie expects this format
      const puppeteerCookie = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite || "None",
      };

      await page.setCookie(puppeteerCookie);
    } catch (error) {
      console.log(`⚠️  Failed to set cookie ${cookie.name}: ${error.message}`);
    }
  }

  console.log(`✅ Applied ${cookies.length} cookies to page`);
  return true;
}

// ============================================
// BROWSER CONFIGURATION (Updated for Brave)
// ============================================

function getBrowserExecutablePath() {
  // Priority 1: Environment variable (for custom paths)
  if (process.env.BROWSER_EXECUTABLE_PATH) {
    return process.env.BROWSER_EXECUTABLE_PATH;
  }

  // Priority 2: Brave Browser (Mac)
  if (process.platform === "darwin") {
    const bravePath =
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    const chromePath =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    // Check if Brave exists
    const fs = require("fs");
    if (fs.existsSync(bravePath)) {
      console.log("🦁 Using Brave Browser");
      return bravePath;
    }

    console.log("🔵 Using Chrome");
    return chromePath;
  }

  // Priority 3: Railway/Linux
  if (isRailway()) {
    return "/usr/bin/google-chrome-stable";
  }

  // Priority 4: Linux default
  return "google-chrome-stable";
}

// Update createBrowser to use new function
function createBrowser(headless = "new") {
  const isHeadlessMode = headless === "new" || headless === true;

  return puppeteer.launch({
    headless: headless,
    executablePath: getBrowserExecutablePath(), // ← Changed
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,1080",
      ...(isRailway() && isHeadlessMode
        ? ["--disable-gpu", "--single-process"]
        : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: isHeadlessMode ? { width: 1920, height: 1080 } : null,
  });
}

// ============================================
// PAGE DETECTION
// ============================================
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

  if (IS_DEBUG) {
    console.log("📄 Page text preview:", pageText.substring(0, 200));
  }

  const pageHeading = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const heading = document.querySelector('[role="heading"]');
    return (h1?.innerText || heading?.innerText || "").toLowerCase();
  });

  const inputPlaceholder = await page.evaluate(() => {
    const input =
      document.querySelector('input[name="text"]') ||
      document.querySelector('input[autocomplete="username"]') ||
      document.querySelector('input[type="text"]');
    return input ? input.placeholder.toLowerCase() : "";
  });

  if (IS_DEBUG) {
    console.log("📋 Page heading:", pageHeading);
    console.log("🏷️  Input placeholder:", inputPlaceholder);
  }

  // Check for different input types
  const hasUsernameInput = await page.evaluate(() => {
    return !!(
      document.querySelector('input[autocomplete="username"]') ||
      document.querySelector('input[name="text"]') ||
      Array.from(document.querySelectorAll("input")).find((inp) =>
        ["phone", "email", "username"].some((term) =>
          inp.placeholder?.toLowerCase().includes(term),
        ),
      )
    );
  });

  const hasPasswordInput = await page.evaluate(() => {
    return !!(
      document.querySelector('input[name="password"]') ||
      document.querySelector('input[type="password"]')
    );
  });

  const hasTextInput = await page.evaluate(() => {
    return !!document.querySelector(
      'input[data-testid="ocfEnterTextTextInput"]',
    );
  });

  // Screen detection
  const isInitialLoginScreen =
    (inputPlaceholder.includes("phone") &&
      inputPlaceholder.includes("email") &&
      inputPlaceholder.includes("username")) ||
    pageText.includes("phone, email, or username");

  const isUsernamePhoneScreen =
    (inputPlaceholder.includes("phone") &&
      inputPlaceholder.includes("username") &&
      !inputPlaceholder.includes("email")) ||
    (pageText.includes("username") &&
      pageText.includes("phone") &&
      !pageText.includes("email"));

  const isEmailVerificationScreen =
    pageText.includes("enter your phone number or email") ||
    pageText.includes("unusual login activity") ||
    pageText.includes("verify it's you");

  const hasOTPPrompt =
    pageText.includes("verification code") ||
    pageText.includes("we sent you a code") ||
    pageText.includes("enter the code");

  const hasCaptcha =
    pageHTML.includes("captcha") || pageHTML.includes("recaptcha");

  const isLoggedIn =
    (await page.$('[data-testid="SideNav_NewTweet_Button"]')) !== null;

  if (IS_DEBUG) {
    console.log("🔍 Detection results:", {
      hasUsernameInput,
      hasPasswordInput,
      hasTextInput,
      isInitialLoginScreen,
      isUsernamePhoneScreen,
      isEmailVerificationScreen,
      hasOTPPrompt,
      hasCaptcha,
      isLoggedIn,
    });
  }

  // Priority detection
  if (isLoggedIn) {
    return { step: "LOGGED_IN" };
  }

  if (hasCaptcha) {
    return {
      step: "CAPTCHA",
      message: "CAPTCHA detected - cannot proceed automatically",
    };
  }

  if (hasPasswordInput) {
    return {
      step: "PASSWORD",
      selector: 'input[name="password"], input[type="password"]',
    };
  }

  if (hasOTPPrompt && hasTextInput) {
    return {
      step: "OTP",
      selector: 'input[data-testid="ocfEnterTextTextInput"]',
    };
  }

  if (isEmailVerificationScreen && hasTextInput) {
    const selector = await page.evaluate(() => {
      const emailInput = document.querySelector(
        'input[data-testid="ocfEnterTextTextInput"]',
      );
      if (emailInput) return 'input[data-testid="ocfEnterTextTextInput"]';
      const textInput = document.querySelector('input[name="text"]');
      if (textInput) return 'input[name="text"]';
      return "input";
    });
    return { step: "EMAIL_VERIFICATION", selector };
  }

  if (isInitialLoginScreen && hasUsernameInput) {
    const selector = await page.evaluate(() => {
      return (
        'input[name="text"]' || 'input[autocomplete="username"]' || "input"
      );
    });
    return { step: "EMAIL", selector };
  }

  if (isUsernamePhoneScreen && hasUsernameInput) {
    const selector = await page.evaluate(() => {
      return (
        'input[name="text"]' || 'input[autocomplete="username"]' || "input"
      );
    });
    return { step: "USERNAME", selector };
  }

  if (hasUsernameInput) {
    const selector = await page.evaluate(() => {
      return (
        'input[name="text"]' || 'input[autocomplete="username"]' || "input"
      );
    });
    return { step: "EMAIL", selector };
  }

  return {
    step: "UNKNOWN",
    pageText: pageText.substring(0, 500),
    pageHeading,
    inputPlaceholder,
  };
}

// ============================================
// INPUT HANDLING
// ============================================
async function fillInputAndProceed(page, selector, value, fieldName = "field") {
  console.log(`   ⌨️  Typing ${fieldName}...`);

  let input;
  try {
    input = await page.waitForSelector(selector, {
      timeout: 10000,
      visible: true,
    });
  } catch (error) {
    const altSelectors = [
      'input[name="text"]',
      'input[autocomplete="username"]',
      'input[type="text"]',
    ];

    for (const altSel of altSelectors) {
      try {
        input = await page.waitForSelector(altSel, {
          timeout: 3000,
          visible: true,
        });
        if (input) {
          selector = altSel;
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

  // Clear and type
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(500);

  console.log(`   📝 Typing: "${value}"`);
  await input.type(value, { delay: 100 });
  await page.waitForTimeout(1000);

  // Verify
  const enteredValue = await page.evaluate((sel) => {
    const inp = document.querySelector(sel);
    return inp ? inp.value : "";
  }, selector);

  console.log(`   ✓ Input value: "${enteredValue}"`);

  if (enteredValue !== value) {
    await input.click();
    await page.keyboard.type(value, { delay: 120 });
    await page.waitForTimeout(1000);
  }

  console.log(`   🖱️  Submitting...`);

  // Try Enter key first
  try {
    await page.keyboard.press("Enter");
    console.log(`   ✓ Pressed Enter`);
  } catch (e) {
    // Fallback to button click
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('div[role="button"], button'),
      );
      const nextButton = buttons.find((btn) => {
        const text = btn.textContent?.trim().toLowerCase();
        return text === "next" || text === "log in" || text === "login";
      });
      if (nextButton) {
        nextButton.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      throw new Error("Could not submit form!");
    }
  }

  console.log(`   ⏳ Waiting for navigation...`);

  // Wait for next step
  try {
    await Promise.race([
      page.waitForSelector('input[type="password"]', {
        visible: true,
        timeout: 10000,
      }),
      page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
        visible: true,
        timeout: 10000,
      }),
      page.waitForFunction(
        (oldSelector) => !document.querySelector(oldSelector),
        { timeout: 10000 },
        selector,
      ),
    ]);
    console.log(`   ✓ Navigation successful`);
  } catch (e) {
    console.log(`   ⚠️  Could not confirm navigation`);
    if (IS_DEBUG) {
      await page.screenshot({
        path: `debug-transition-${fieldName}-${Date.now()}.png`,
      });
    }
  }

  await page.waitForTimeout(2000);
}

async function humanDelay(min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "x Automation Service",
    version: "5.0.0",
    mode: IS_PRODUCTION ? "production" : "development",
    debug: IS_DEBUG,
    recommendation: "⭐ Use /manual-login for best results",
    credentials: {
      username: x_USERNAME !== "your_username_here" ? "✅ Set" : "❌ Not set",
      password: x_PASSWORD !== "your_password_here" ? "✅ Set" : "❌ Not set",
      email: x_EMAIL !== "your_email_here" ? "✅ Set" : "❌ Not set",
    },
    features: [
      "Manual login helper (recommended)",
      "Automated login (may be blocked)",
      "Cookie-based sessions",
      "Tweet posting",
      "OTP support",
    ],
    endpoints: {
      "POST /manual-login": "🌟 Open browser for manual login (RECOMMENDED)",
      "POST /login": "Automated login (may fail due to bot detection)",
      "POST /continue-login": "Continue with OTP",
      "POST /post-tweet": "Post a tweet",
      "GET /check-session": "Verify cookie validity",
      "DELETE /logout": "Clear cookies",
    },
  });
});

// Ultra-clean manual login (no automation flags)
app.post("/manual-login-clean", async (req, res) => {
  if (isRailway()) {
    return res.status(400).json({
      success: false,
      error: "Manual login not available in production",
      message:
        "Please login locally in your regular Chrome browser and copy cookies manually",
      instructions: [
        "1. Open Chrome → DevTools (F12) → Application tab → Cookies",
        "2. Login to x.com normally",
        "3. Copy all cookies (especially auth_token, ct0)",
        "4. Create x-cookies.json file manually",
      ],
    });
  }

  let browser;
  const sessionId = Date.now().toString();

  try {
    console.log(`\n[${sessionId}] 🧹 Starting ULTRA-CLEAN manual login...`);
    console.log(
      `[${sessionId}] 🔓 Opening browser with ZERO automation flags...`,
    );

    // Launch with MINIMAL flags - as close to normal Chrome as possible
    browser = await puppeteer.launch({
      headless: false,
      executablePath: getBrowserExecutablePath(),
      // ONLY the absolutely necessary flags
      args: [
        "--no-sandbox", // Required for some systems
        "--disable-setuid-sandbox", // Required for some systems
      ],
      // Don't ignore any default args - use everything Chrome normally uses
      // ignoreDefaultArgs: ["--enable-automation"], // REMOVED
      defaultViewport: null,
    });

    const page = await browser.newPage();

    // NO user agent override, NO headers override - be completely natural
    // await page.setUserAgent(...); // REMOVED
    // await page.setExtraHTTPHeaders(...); // REMOVED

    console.log(`[${sessionId}] 🌐 Opening x...`);
    await page.goto("https://x.com/i/flow/login", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${sessionId}] 👋 BROWSER OPENED!`);
    console.log(`${"=".repeat(60)}`);
    console.log(`\n📝 INSTRUCTIONS:`);
    console.log(`   1. The browser window is now open`);
    console.log(`   2. Login to x MANUALLY with your real credentials`);
    console.log(`   3. Once you see the x home feed, wait 5 seconds`);
    console.log(`   4. Cookies will be saved automatically\n`);
    console.log(`⏰ Timeout: 3 minutes\n`);
    console.log(`${"=".repeat(60)}\n`);

    let loggedIn = false;
    const maxAttempts = 36; // 3 minutes (36 * 5 seconds)

    for (let i = 0; i < maxAttempts; i++) {
      await page.waitForTimeout(5000);

      const currentUrl = page.url();
      const isOnHome =
        currentUrl.includes("/home") ||
        currentUrl === "https://x.com/" ||
        currentUrl === "https://x.com/";

      const hasTweetButton = await page.$(
        '[data-testid="SideNav_NewTweet_Button"]',
      );

      if (isOnHome || hasTweetButton) {
        loggedIn = true;
        console.log(`\n[${sessionId}] ✅ LOGIN DETECTED! Saving cookies...`);
        break;
      }

      if (i % 3 === 0) {
        // Log every 15 seconds
        console.log(
          `[${sessionId}] ⏳ Waiting for login... (${Math.floor((i * 5) / 60)}m ${(i * 5) % 60}s / 3m)`,
        );
      }
    }
    // In the manual-login-clean endpoint, update this section:

    if (!loggedIn) {
      await browser.close();
      return res.status(408).json({
        success: false,
        error: "Timeout",
        message: "Login timeout after 3 minutes. Please try again.",
      });
    }

    // Wait a bit more to ensure all cookies are set
    console.log(`[${sessionId}] ⏳ Waiting for cookies to be fully set...`);
    await page.waitForTimeout(3000);

    // Get cookies from Puppeteer
    const puppeteerCookies = await page.cookies();

    console.log(
      `[${sessionId}] 📦 Retrieved ${puppeteerCookies.length} cookies from browser`,
    );

    // Save with proper formatting
    const formattedCookies = await saveCookies(puppeteerCookies);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${sessionId}] 🎉 SUCCESS!`);
    console.log(`${"=".repeat(60)}`);
    console.log(`   💾 Cookies saved: ${formattedCookies.length} cookies`);
    console.log(`   📂 Location: ${COOKIES_PATH}`);
    console.log(`   ✅ You can now use POST /post-tweet\n`);
    console.log(`${"=".repeat(60)}\n`);

    await page.waitForTimeout(2000);
    await browser.close();

    return res.json({
      success: true,
      message: "🎉 Manual login successful! Cookies saved.",
      sessionId: sessionId,
      cookiesCount: formattedCookies.length,
      cookiesFile: COOKIES_PATH,
      cookieDetails: {
        hasAuthToken: formattedCookies.some((c) => c.name === "auth_token"),
        hasCt0: formattedCookies.some((c) => c.name === "ct0"),
        hasTwid: formattedCookies.some((c) => c.name === "twid"),
      },
      nextStep: "Use POST /post-tweet to post tweets!",
    });
  } catch (error) {
    console.error(`[${sessionId}] ❌ Error: ${error.message}`);
    if (browser) await browser.close();

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: IS_DEBUG ? error.stack : undefined,
    });
  }
});

// Automated login (may fail due to bot detection)
app.post("/login", async (req, res) => {
  const username = x_USERNAME;
  const password = x_PASSWORD;
  const email = x_EMAIL;

  if (username === "your_username_here" || password === "your_password_here") {
    return res.status(400).json({
      success: false,
      error: "Credentials not set",
      message: "Please set x_USERNAME, x_PASSWORD, x_EMAIL",
    });
  }

  let browser;
  const sessionId = Date.now().toString();

  try {
    log(sessionId, "🚀 Starting AUTOMATED login...");
    log(
      sessionId,
      "⚠️  Note: May fail due to bot detection. Use /manual-login instead.",
    );
    log(sessionId, `👤 Username: ${username}`);
    log(sessionId, `📧 Email: ${email}`);

    browser = await createBrowser("new");

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

    log(sessionId, "🌐 Loading x login page...");
    await page.goto("https://x.com/i/flow/login", {
      waitUntil: "networkidle0",
      timeout: 90000,
    });

    await page.waitForSelector("input", { timeout: 15000 });
    await page.waitForTimeout(3000);

    const maxSteps = 10;
    let currentStep = 0;
    const credentials = { username, password, email };

    // Loop detection
    let lastStep = null;
    let sameStepCount = 0;

    while (currentStep < maxSteps) {
      currentStep++;
      log(sessionId, `📍 Step ${currentStep}: Detecting...`);

      const detected = await detectCurrentStep(page);
      log(sessionId, `➡️  Detected: ${detected.step}`);

      // Loop detection
      if (detected.step === lastStep && detected.step !== "LOGGED_IN") {
        sameStepCount++;
        if (sameStepCount >= 3) {
          await browser.close();
          return res.status(400).json({
            success: false,
            error: "x rejected automated login",
            message:
              "x's bot detection blocked the login. Please use POST /manual-login instead.",
            stuckOn: detected.step,
            attempts: sameStepCount,
            recommendation: "Use /manual-login endpoint for reliable login",
          });
        }
      } else {
        sameStepCount = 0;
      }
      lastStep = detected.step;

      if (IS_DEBUG) {
        await page.screenshot({ path: `debug-step-${currentStep}.png` });
        log(sessionId, `📸 Screenshot: debug-step-${currentStep}.png`);
      }

      if (detected.step === "LOGGED_IN") {
        log(sessionId, "✅ Login successful!");
        const cookies = await page.cookies();
        await saveCookies(cookies);
        await browser.close();

        return res.json({
          success: true,
          message: "🎉 Login successful! Cookies saved.",
          sessionId: sessionId,
          steps: currentStep,
          cookiesCount: cookies.length,
        });
      }

      if (detected.step === "CAPTCHA") {
        await browser.close();
        return res.status(400).json({
          success: false,
          error: "CAPTCHA detected",
          message: "Please use /manual-login to solve CAPTCHA manually",
        });
      }

      if (detected.step === "USERNAME") {
        log(sessionId, "👤 Entering username...");
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.username,
          "username",
        );
        continue;
      }

      if (detected.step === "PASSWORD") {
        log(sessionId, "🔐 Entering password...");
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.password,
          "password",
        );
        continue;
      }

      if (detected.step === "EMAIL" || detected.step === "EMAIL_VERIFICATION") {
        log(sessionId, "📧 Entering email...");
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.email,
          "email",
        );
        continue;
      }

      if (detected.step === "OTP") {
        log(sessionId, "🔢 OTP required - pausing for user input");

        pendingSessions.set(sessionId, { browser, page, credentials });
        setTimeout(() => {
          if (pendingSessions.has(sessionId)) {
            log(sessionId, "⏱️  Session expired (5 min timeout)");
            pendingSessions.delete(sessionId);
            browser.close();
          }
        }, 300000);

        return res.json({
          success: false,
          needsOTP: true,
          sessionId: sessionId,
          message: "📱 x sent a verification code",
          instruction: `Call POST /continue-login with { "sessionId": "${sessionId}", "otp": "123456" }`,
        });
      }

      if (detected.step === "UNKNOWN") {
        log(sessionId, "❓ Unknown page state");
        pendingSessions.set(sessionId, { browser, page, credentials });

        return res.json({
          success: false,
          unknownStep: true,
          sessionId: sessionId,
          pageText: detected.pageText,
          message: "⚠️  Unexpected page state. Use /manual-login instead.",
        });
      }

      await page.waitForTimeout(2000);
    }

    await browser.close();
    return res.status(500).json({
      success: false,
      error: "Max login steps exceeded",
      message: "Please use /manual-login instead",
    });
  } catch (error) {
    log(sessionId, `❌ Error: ${error.message}`);
    if (browser) await browser.close();

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: IS_DEBUG ? error.stack : undefined,
    });
  }
});

// Continue login with OTP
app.post("/continue-login", async (req, res) => {
  const { sessionId, otp } = req.body;

  if (!sessionId || !otp) {
    return res.status(400).json({
      success: false,
      error: "Missing sessionId or otp",
      message: 'Provide: { "sessionId": "xxx", "otp": "123456" }',
    });
  }

  const session = pendingSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Session not found or expired",
      message: "Session may have timed out. Please start new login.",
    });
  }

  const { browser, page, credentials } = session;

  try {
    log(sessionId, `🔄 Continuing with OTP: ${otp}`);
    credentials.otp = otp;

    let maxSteps = 10;
    let currentStep = 0;

    while (currentStep < maxSteps) {
      currentStep++;
      log(sessionId, `📍 Continue Step ${currentStep}: Detecting...`);

      const detected = await detectCurrentStep(page);
      log(sessionId, `➡️  Detected: ${detected.step}`);

      if (detected.step === "LOGGED_IN") {
        log(sessionId, "✅ Login successful after OTP!");
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
        log(sessionId, "🔢 Entering OTP...");
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.otp,
          "OTP",
        );
        continue;
      }

      if (detected.step === "PASSWORD") {
        log(sessionId, "🔐 Re-entering password...");
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.password,
          "password",
        );
        continue;
      }

      if (detected.step === "EMAIL") {
        log(sessionId, "📧 Re-entering email...");
        await fillInputAndProceed(
          page,
          detected.selector,
          credentials.email,
          "email",
        );
        continue;
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
    log(sessionId, `❌ OTP continuation error: ${error.message}`);
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
      message: "No saved cookies. Please login first using /manual-login",
    });
  }

  let browser;
  try {
    browser = await createBrowser("new");
    const page = await browser.newPage();
    await page.setCookie(...cookies);

    try {
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (navError) {
      // Continue anyway
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
        : "❌ Session expired - please re-login using /manual-login",
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

// Post tweet
// ============================================
// POST TWEET ENDPOINT
// ============================================

app.post("/post-tweet", async (req, res) => {
  const { tweetText } = req.body;
  const sessionId = Date.now().toString();

  if (!tweetText) {
    return res.status(400).json({
      success: false,
      error: "Missing tweetText parameter",
      example: { tweetText: "Your tweet here" }
    });
  }

  if (tweetText.length > 280) {
    return res.status(400).json({
      success: false,
      error: `Tweet too long: ${tweetText.length}/280 characters`
    });
  }

  let browser;
  try {
    log(sessionId, "📤 Starting tweet post...");
    log(sessionId, `📝 Tweet: ${tweetText}`);

    // Load cookies
    const cookies = await loadCookies();
    if (!cookies) {
      return res.status(401).json({
        success: false,
        error: "No cookies found",
        message: "Please run POST /manual-login-clean first"
      });
    }

    log(sessionId, `✅ Loaded ${cookies.length} cookies`);

    // Launch browser
    browser = await createBrowser("new"); // headless
    const page = await browser.newPage();

    // Apply cookies
    await applyCookies(page, cookies);

    // Navigate to X
    log(sessionId, "🌐 Loading X.com...");
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    // Check if logged in
    const isLoggedIn = (await page.$('[data-testid="SideNav_NewTweet_Button"]')) !== null;
    
    if (!isLoggedIn) {
      await browser.close();
      return res.status(401).json({
        success: false,
        error: "Session expired",
        message: "Cookies are invalid. Please run POST /manual-login-clean again"
      });
    }

    log(sessionId, "✅ Session valid!");

    // Click tweet button
    log(sessionId, "🖱️  Opening composer...");
    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await page.waitForTimeout(2000);

    // Type tweet
    log(sessionId, "⌨️  Typing tweet...");
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { visible: true });
    await page.click('[data-testid="tweetTextarea_0"]');
    await page.waitForTimeout(500);

    // Type character by character for emojis
    await page.type('[data-testid="tweetTextarea_0"]', tweetText, { delay: 50 });
    await page.waitForTimeout(2000);

    // Click post
    log(sessionId, "📤 Posting tweet...");
    await page.click('[data-testid="tweetButton"]');
    await page.waitForTimeout(5000);

    await browser.close();

    log(sessionId, "✅ Tweet posted successfully!");

    return res.json({
      success: true,
      message: "Tweet posted successfully!",
      sessionId: sessionId,
      tweet: {
        text: tweetText,
        length: tweetText.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    log(sessionId, `❌ Error: ${error.message}`);
    
    if (browser) {
      await browser.close();
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      sessionId: sessionId
    });
  }
});


// Logout
app.delete("/logout", async (req, res) => {
  try {
    await fs.unlink(COOKIES_PATH);

    // Also clear environment backup
    if (process.env.x_COOKIES_BACKUP) {
      delete process.env.x_COOKIES_BACKUP;
    }

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

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(50));
  console.log("🚀 x Automation Service v5.0");
  console.log("=".repeat(50));
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🐛 Debug mode: ${IS_DEBUG ? "ON" : "OFF"}`);
  console.log(`📂 Cookies path: ${COOKIES_PATH}`);
  console.log("\n⚙️  Credentials:");
  console.log(
    `   Username: ${x_USERNAME !== "your_username_here" ? "✅ " + x_USERNAME : "❌ Not set"}`,
  );
  console.log(
    `   Password: ${x_PASSWORD !== "your_password_here" ? "✅ Set" : "❌ Not set"}`,
  );
  console.log(
    `   Email: ${x_EMAIL !== "your_email_here" ? "✅ " + x_EMAIL : "❌ Not set"}`,
  );
  console.log("\n💡 Quick Start:");
  console.log("   1. POST /manual-login  (recommended)");
  console.log("   2. POST /post-tweet");
  console.log("\n" + "=".repeat(50) + "\n");
});
