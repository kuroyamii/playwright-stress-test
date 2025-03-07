// stress-test.js
const { chromium, firefox, webkit } = require("playwright");
const fs = require("fs");
const os = require("os");

// Base domains with their subpaths from NX-Park website content
const domains = {
  "https://nx-park.com": ["/news", "/contact"],
};

// Browsers to test
const browsers = [{ name: "Chromium", launcher: chromium }];

// Test configuration
const CONCURRENT_USERS = 100;
const USER_DELAY_MIN = 200; // Min delay between user actions in ms
const USER_DELAY_MAX = 1000; // Max delay between user actions in ms

// Results tracking
let totalRequests = 0;
let successfulRequests = 0;
let failedRequests = 0;
let responseTimeTotal = 0;
const responseTimeBuckets = {
  "< 500ms": 0,
  "500ms-1s": 0,
  "1s-3s": 0,
  "3s-5s": 0,
  "5s-10s": 0,
  "> 10s": 0,
};

// Performance tracking
const requestCountPerPath = {};
const successCountPerPath = {};
const responseTimePerPath = {};

// Error tracking
const errorTypes = {};
const errorsByPath = {};
const statusCodeCounts = {};

// Helper function to get human-readable path name
function getReadablePath(path) {
  if (path === "/" || path === "") return "Home";

  // Remove leading slash and replace other slashes with spaces
  let readable = path.replace(/^\//, "").replace(/\//g, " / ");

  // Capitalize first letter of each word
  readable = readable.replace(/\b\w/g, (match) => match.toUpperCase());

  return readable;
}

// Track response time in appropriate bucket
function trackResponseTime(responseTime) {
  responseTimeTotal += responseTime;

  if (responseTime < 500) {
    responseTimeBuckets["< 500ms"]++;
  } else if (responseTime < 1000) {
    responseTimeBuckets["500ms-1s"]++;
  } else if (responseTime < 3000) {
    responseTimeBuckets["1s-3s"]++;
  } else if (responseTime < 5000) {
    responseTimeBuckets["3s-5s"]++;
  } else if (responseTime < 10000) {
    responseTimeBuckets["5s-10s"]++;
  } else {
    responseTimeBuckets["> 10s"]++;
  }
}

// Track per-path performance metrics
function trackPathMetrics(url, responseTime, isSuccess) {
  // Extract domain and path
  const urlObj = new URL(url);
  const domain = urlObj.origin;
  const path = urlObj.pathname || "/";
  const pathKey = domain + path;

  // Initialize if first time seeing this path
  if (!requestCountPerPath[pathKey]) {
    requestCountPerPath[pathKey] = 0;
    successCountPerPath[pathKey] = 0;
    responseTimePerPath[pathKey] = 0;
  }

  // Update metrics
  requestCountPerPath[pathKey]++;
  if (isSuccess) {
    successCountPerPath[pathKey]++;
    responseTimePerPath[pathKey] += responseTime;
  }
}

// Track error information
function trackError(url, statusCode, errorMessage) {
  // Categorize the error
  let errorType = "Unknown Error";

  if (statusCode) {
    // HTTP status error
    errorType = `HTTP ${statusCode}`;

    // Track status code counts
    if (!statusCodeCounts[statusCode]) {
      statusCodeCounts[statusCode] = 0;
    }
    statusCodeCounts[statusCode]++;
  } else if (errorMessage) {
    // JavaScript error
    if (errorMessage.includes("timeout")) {
      errorType = "Timeout";
    } else if (errorMessage.includes("net::")) {
      errorType = "Network Error";
    } else if (errorMessage.includes("SSL")) {
      errorType = "SSL Error";
    } else if (errorMessage.includes("Navigation")) {
      errorType = "Navigation Error";
    } else {
      // Extract the first part of the error message for categorization
      const shortError = errorMessage.split(":")[0].trim();
      errorType = shortError.length > 0 ? shortError : "Unknown Error";
    }
  }

  // Track error type counts
  if (!errorTypes[errorType]) {
    errorTypes[errorType] = {
      count: 0,
      examples: [],
    };
  }
  errorTypes[errorType].count++;

  // Keep a few examples per error type
  if (errorTypes[errorType].examples.length < 3) {
    errorTypes[errorType].examples.push({
      url,
      errorMessage: errorMessage || `Status code: ${statusCode}`,
    });
  }

  // Track errors by path
  const urlObj = new URL(url);
  const path = urlObj.pathname || "/";
  const pathKey = urlObj.origin + path;

  if (!errorsByPath[pathKey]) {
    errorsByPath[pathKey] = [];
  }

  // Keep at most 5 errors per path
  if (errorsByPath[pathKey].length < 5) {
    errorsByPath[pathKey].push({
      errorType,
      statusCode,
      errorMessage: errorMessage || `Status code: ${statusCode}`,
    });
  }
}

// Test a single URL with a user
async function testUrl(userId, url, browserType) {
  console.log(`User ${userId} requesting: ${url}`);

  // Launch browser
  const browser = await browserType.launcher.launch({
    ignoreHTTPSErrors: true,
    headless: true,
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: `StressTestBot/1.0 User-${userId}`,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });

  // Enable request/response logging
  const requestLog = [];
  context.on("request", (request) => {
    requestLog.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: Date.now(),
    });
  });

  context.on("response", (response) => {
    const request = response.request();
    const existing = requestLog.find(
      (r) => r.url === request.url() && r.method === request.method()
    );
    if (existing) {
      existing.status = response.status();
      existing.responseTimestamp = Date.now();
    }
  });

  const page = await context.newPage();
  totalRequests++;

  try {
    // Capture console logs
    const consoleLogs = [];
    page.on("console", (msg) => {
      consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
      });
    });

    // Capture page errors
    const pageErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.toString());
    });

    // Increase timeout and add retry logic
    const startTime = Date.now();

    // Request the page with retry logic
    let retries = 0;
    const maxRetries = 2;
    let response = null;
    let lastError = null;

    while (retries <= maxRetries) {
      try {
        response = await page.goto(url, {
          timeout: 60000, // Increased timeout
          waitUntil: "domcontentloaded", // Changed from "load" to be less strict
        });

        // If we get here, the navigation succeeded
        break;
      } catch (error) {
        lastError = error;
        retries++;
        console.log(
          `User ${userId} retry ${retries}/${maxRetries} for ${url} (${error.message})`
        );

        // If we've exhausted retries, break out
        if (retries > maxRetries) {
          break;
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const responseTime = Date.now() - startTime;

    // Check if successful
    if (response && response.status() < 400) {
      successfulRequests++;
      trackResponseTime(responseTime);
      trackPathMetrics(url, responseTime, true);
      console.log(`User ${userId} success: ${url} (${responseTime}ms)`);

      // Do a quick interaction to simulate real user
      await page.mouse.move(100, 100);
      await page.evaluate(() => window.scrollBy(0, 300));

      // Wait a bit to allow page analytics to register
      await page.waitForTimeout(randomDelay(USER_DELAY_MIN, USER_DELAY_MAX));
    } else {
      failedRequests++;
      const status = response ? response.status() : "No response";
      const errorMsg = lastError ? lastError.message : null;

      console.log(
        `User ${userId} failed: ${url} (Status: ${status}, Error: ${errorMsg})`
      );
      trackPathMetrics(url, responseTime, false);
      trackError(url, response ? response.status() : null, errorMsg);

      // Save page content and screenshots for debugging - only for some users
      if (userId % 10 === 0) {
        const timestamp = Date.now();
        const urlSafe = url.replace(/[^a-z0-9]/gi, "_").substring(0, 50);

        try {
          // Create logs directory if it doesn't exist
          const logDir = "stress_test_logs";
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
          }

          // Save HTML content
          const content = await page.content();
          fs.writeFileSync(
            `${logDir}/error_${urlSafe}_${timestamp}.html`,
            content
          );

          // Save screenshot
          await page.screenshot({
            path: `${logDir}/error_${urlSafe}_${timestamp}.png`,
            fullPage: false,
          });

          // Save request log
          fs.writeFileSync(
            `${logDir}/error_${urlSafe}_${timestamp}_requests.json`,
            JSON.stringify(requestLog, null, 2)
          );

          // Save console logs
          if (consoleLogs.length > 0) {
            fs.writeFileSync(
              `${logDir}/error_${urlSafe}_${timestamp}_console.json`,
              JSON.stringify(consoleLogs, null, 2)
            );
          }

          // Save page errors
          if (pageErrors.length > 0) {
            fs.writeFileSync(
              `${logDir}/error_${urlSafe}_${timestamp}_errors.json`,
              JSON.stringify(pageErrors, null, 2)
            );
          }
        } catch (logError) {
          console.error(`Failed to save debug info: ${logError.message}`);
        }
      }
    }
  } catch (error) {
    failedRequests++;
    console.log(`User ${userId} error: ${url} (${error.message})`);
    trackPathMetrics(url, 0, false);
    trackError(url, null, error.message);
  } finally {
    await browser.close();
  }
}

// Random delay between min and max
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// Run the stress test
async function runStressTest() {
  console.log(`Starting stress test with ${CONCURRENT_USERS} users...`);
  console.log(
    `System info: ${os.type()} ${os.release()}, ${
      os.cpus().length
    } CPUs, ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB RAM`
  );

  const startTime = Date.now();

  // Generate all URLs to test (main domain + subpaths)
  const allUrls = [];
  for (const domain in domains) {
    // Add main domain
    allUrls.push(domain);

    // Add subpaths
    for (const path of domains[domain]) {
      allUrls.push(domain + path);
    }
  }

  console.log(
    `Testing ${
      allUrls.length
    } URLs with ${CONCURRENT_USERS} users each (total: ${
      allUrls.length * CONCURRENT_USERS
    } tests)`
  );

  // Create a queue of all tests to run
  const testQueue = [];
  for (let userId = 1; userId <= CONCURRENT_USERS; userId++) {
    const browserTypeIndex = (userId - 1) % browsers.length;
    const browserType = browsers[browserTypeIndex];

    for (const url of allUrls) {
      testQueue.push({ userId, url, browserType });
    }
  }

  // Shuffle the queue for more realistic load pattern
  for (let i = testQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [testQueue[i], testQueue[j]] = [testQueue[j], testQueue[i]];
  }

  // Process queue with concurrency limit
  const concurrencyLimit = Math.min(15, os.cpus().length); // Reduced limit to avoid overwhelming the server
  const runningPromises = new Set();

  while (testQueue.length > 0 || runningPromises.size > 0) {
    // Fill up to concurrency limit
    while (runningPromises.size < concurrencyLimit && testQueue.length > 0) {
      const test = testQueue.shift();

      const promise = testUrl(test.userId, test.url, test.browserType)
        .catch((error) => console.error(`Test error: ${error}`))
        .finally(() => {
          runningPromises.delete(promise);
        });

      runningPromises.add(promise);
    }

    // Wait for at least one test to complete before continuing
    if (runningPromises.size > 0) {
      await Promise.race(runningPromises);
    }
  }

  const endTime = Date.now();
  const totalTimeInSeconds = (endTime - startTime) / 1000;

  // Generate report
  generateReport(totalTimeInSeconds);
}

// Generate HTML report
function generateReport(testDurationSeconds) {
  // Calculate metrics
  const avgResponseTime =
    successfulRequests > 0
      ? Math.round(responseTimeTotal / successfulRequests)
      : 0;
  const requestsPerSecond =
    Math.round((totalRequests / testDurationSeconds) * 100) / 100;
  const successRate =
    totalRequests > 0
      ? Math.round((successfulRequests / totalRequests) * 100)
      : 0;

  // Create path-specific metrics
  const pathMetrics = [];
  for (const pathKey in requestCountPerPath) {
    const successRate = Math.round(
      (successCountPerPath[pathKey] / requestCountPerPath[pathKey]) * 100
    );
    const avgResponseTime =
      successCountPerPath[pathKey] > 0
        ? Math.round(
            responseTimePerPath[pathKey] / successCountPerPath[pathKey]
          )
        : 0;

    // Parse URL to get domain and path
    const urlObj = new URL(pathKey);
    const domain = urlObj.origin;
    const path = urlObj.pathname || "/";

    pathMetrics.push({
      domain,
      path,
      requests: requestCountPerPath[pathKey],
      successRate,
      avgResponseTime,
      hasErrors: errorsByPath[pathKey] ? true : false,
    });
  }

  // Sort paths by request count (descending)
  pathMetrics.sort((a, b) => b.requests - a.requests);

  // Group by domain
  const domainGroups = {};
  pathMetrics.forEach((metric) => {
    if (!domainGroups[metric.domain]) {
      domainGroups[metric.domain] = [];
    }
    domainGroups[metric.domain].push(metric);
  });

  // Sort error types by frequency
  const sortedErrorTypes = Object.entries(errorTypes)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, data]) => ({ type, ...data }));

  // Sort status codes by frequency
  const sortedStatusCodes = Object.entries(statusCodeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, count }));

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Website Stress Test Results - ${CONCURRENT_USERS} Users</title>
  <style>
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background-color: #f5f5f5;
      color: #333;
    }
    h1, h2, h3 {
      color: #2c3e50;
    }
    h1 {
      text-align: center;
      margin-bottom: 30px;
      color: #3498db;
    }
    h2 {
      margin-top: 30px;
      padding-bottom: 10px;
      border-bottom: 2px solid #eee;
    }
    h3 {
      margin-top: 20px;
      font-size: 1.1em;
      color: #555;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background-color: #fff;
      border-radius: 10px;
      padding: 30px;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-around;
      gap: 20px;
      margin: 30px 0;
    }
    .metric-card {
      background-color: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      min-width: 200px;
      text-align: center;
      box-shadow: 0 2px 5px rgba(0,0,0,0.05);
    }
    .metric-value {
      font-size: 2em;
      font-weight: bold;
      color: #3498db;
      margin: 10px 0;
    }
    .metric-label {
      font-size: 0.9em;
      color: #7f8c8d;
    }
    .chart-container {
      margin: 30px 0;
      height: 300px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
      margin-bottom: 30px;
    }
    th, td {
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #e9ecef;
    }
    th {
      background-color: #f8f9fa;
      font-weight: bold;
      color: #495057;
    }
    tr:hover {
      background-color: #f9f9f9;
    }
    .success-rate {
      font-weight: bold;
    }
    .high {
      color: #27ae60;
    }
    .medium {
      color: #f39c12;
    }
    .low {
      color: #e74c3c;
    }
    .domain-section {
      padding: 15px;
      background-color: #f8f9fa;
      border-radius: 5px;
      margin-bottom: 20px;
      border-left: 5px solid #3498db;
    }
    .path {
      font-family: monospace;
      color: #0366d6;
    }
    .domain {
      font-weight: bold;
    }
    .response-time-bars {
      display: flex;
      margin: 20px 0;
      height: 250px;
      align-items: flex-end;
    }
    .bar-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 0 5px;
    }
    .bar {
      width: 50px;
      background-color: #3498db;
      transition: height 0.3s;
      border-radius: 5px 5px 0 0;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      color: white;
      font-weight: bold;
      padding-top: 5px;
    }
    .bar-label {
      margin-top: 10px;
      text-align: center;
      font-size: 0.9em;
      font-weight: 500;
      color: #636e72;
    }
    .bar-value {
      margin-top: 5px;
      color: #2d3436;
      font-weight: bold;
    }
    .test-info {
      background-color: #edf7ff;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 25px;
    }
    .test-info-header {
      font-size: 1.2em;
      font-weight: bold;
      margin-bottom: 10px;
      color: #2980b9;
    }
    .test-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
    }
    .test-stat {
      flex: 1;
      min-width: 180px;
    }
    .test-stat-label {
      font-size: 0.85em;
      color: #7f8c8d;
    }
    .test-stat-value {
      font-size: 1.1em;
      font-weight: 500;
      color: #2c3e50;
    }
    .error-detail {
      padding: 10px;
      margin: 10px 0;
      background-color: #fff;
      border-radius: 5px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .error-type {
      font-weight: bold;
      color: #e74c3c;
    }
    .error-count {
      font-weight: bold;
      color: #7f8c8d;
    }
    .error-message {
      margin-top: 5px;
      font-family: monospace;
      font-size: 0.9em;
      color: #34495e;
      padding: 5px;
      background-color: #f8f9fa;
      border-radius: 3px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .error-url {
      font-size: 0.85em;
      color: #3498db;
      margin-bottom: 5px;
    }
    .status-chart {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 20px 0;
    }
    .status-item {
      padding: 10px 15px;
      background-color: #f8f9fa;
      border-radius: 5px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .status-code {
      font-size: 1.5em;
      font-weight: bold;
    }
    .status-count {
      margin-top: 5px;
      color: #7f8c8d;
    }
    .code-2xx { color: #27ae60; }
    .code-3xx { color: #2980b9; }
    .code-4xx { color: #f39c12; }
    .code-5xx { color: #e74c3c; }
    details {
      margin: 10px 0;
    }
    summary {
      cursor: pointer;
      padding: 8px;
      background-color: #f8f9fa;
      border-radius: 5px;
    }
    summary:hover {
      background-color: #e9ecef;
    }
    @media (max-width: 768px) {
      .metric-card {
        min-width: 120px;
      }
      table {
        font-size: 14px;
      }
      th, td {
        padding: 8px 10px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Website Stress Test Results</h1>
    
    <div class="test-info">
      <div class="test-info-header">Test Configuration</div>
      <div class="test-stats">
        <div class="test-stat">
          <div class="test-stat-label">Users</div>
          <div class="test-stat-value">${CONCURRENT_USERS}</div>
        </div>
        <div class="test-stat">
          <div class="test-stat-label">URLs Tested</div>
          <div class="test-stat-value">${
            Object.keys(requestCountPerPath).length
          }</div>
        </div>
        <div class="test-stat">
          <div class="test-stat-label">Test Duration</div>
          <div class="test-stat-value">${Math.floor(
            testDurationSeconds / 60
          )}m ${Math.round(testDurationSeconds % 60)}s</div>
        </div>
        <div class="test-stat">
          <div class="test-stat-label">Completion Time</div>
          <div class="test-stat-value">${new Date().toLocaleString()}</div>
        </div>
      </div>
    </div>
    
    <div class="summary">
      <div class="metric-card">
        <div class="metric-label">Total Requests</div>
        <div class="metric-value">${totalRequests}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Success Rate</div>
        <div class="metric-value">${successRate}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Failed Requests</div>
        <div class="metric-value">${failedRequests}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Requests/Second</div>
        <div class="metric-value">${requestsPerSecond}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Avg Response Time</div>
        <div class="metric-value">${avgResponseTime}ms</div>
      </div>
    </div>
    
    <h2>Response Time Distribution</h2>
    
    <div class="response-time-bars">
      ${Object.entries(responseTimeBuckets)
        .map(([label, count]) => {
          const percentage =
            successfulRequests > 0
              ? Math.round((count / successfulRequests) * 100)
              : 0;
          const height = Math.max(percentage * 2, 5); // Make sure bar has at least 5px height if not 0
          return `
          <div class="bar-container">
            <div class="bar" style="height: ${height}px;">${
            percentage > 10 ? percentage + "%" : ""
          }</div>
            <div class="bar-label">${label}</div>
            <div class="bar-value">${count}</div>
          </div>
        `;
        })
        .join("")}
    </div>
    
    <h2>Performance by URL</h2>
    
    ${Object.keys(domainGroups)
      .map((domain) => {
        const domainMetrics = domainGroups[domain];

        return `
        <div class="domain-section">
          <h3 class="domain">${domain}</h3>
          
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Requests</th>
                <th>Success Rate</th>
                <th>Avg Response Time</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              ${domainMetrics
                .map((metric) => {
                  let successClass = "high";
                  if (metric.successRate < 90) successClass = "medium";
                  if (metric.successRate < 70) successClass = "low";

                  const pathDisplay =
                    metric.path === "/" ? "Home" : getReadablePath(metric.path);
                  const pathKey = metric.domain + metric.path;

                  return `
                  <tr>
                    <td class="path">${pathDisplay}</td>
                    <td>${metric.requests}</td>
                    <td class="success-rate ${successClass}">${
                    metric.successRate
                  }%</td>
                    <td>${metric.avgResponseTime}ms</td>
                    <td>
                      ${
                        metric.hasErrors
                          ? `
                        <details>
                          <summary>View Errors</summary>
                          ${errorsByPath[pathKey]
                            .map(
                              (error) => `
                            <div class="error-message">${error.errorType}: ${error.errorMessage}</div>
                          `
                            )
                            .join("")}
                        </details>
                      `
                          : "None"
                      }
                    </td>
                  </tr>
                `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      `;
      })
      .join("")}
    
    <div style="margin-top: 20px; text-align: center; color: #777; font-size: 12px;">
      <p>System: ${os.type()} ${os.release()}, ${
    os.cpus().length
  } CPUs, ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB RAM</p>
    </div>
  </div>
</body>
</html>
  `;

  fs.writeFileSync("stress-test-report.html", html);
  console.log(
    `Test completed in ${testDurationSeconds.toFixed(
      1
    )} seconds. Report saved to stress-test-report.html`
  );
}

// Run the stress test
runStressTest().catch(console.error);
