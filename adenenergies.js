// stress-test.js
const { chromium, firefox, webkit } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Base domains with their subpaths
const domains = {
  "https://adenenergies.com": [
    "/about",
    "/solutions",
    "/media",
    "/contact",
    "/zh",
    "/zh/about",
    "/zh/solutions",
    "/zh/media",
    "/zh/contact",
  ],
};

// Browsers to test
const browsers = [{ name: "Chromium", launcher: chromium }];

// Test configuration
const MIN_USERS = 20; // Starting number of concurrent users
const MAX_USERS = 500; // Maximum number of concurrent users to test
const STEP_SIZE = 20; // How many users to add in each step
const USER_DELAY_MIN = 200; // Min delay between user actions in ms
const USER_DELAY_MAX = 1000; // Max delay between user actions in ms
const THRESHOLD_SUCCESS = 90; // Success rate threshold to consider a load level acceptable
const THRESHOLD_RESPONSE = 60000; // Response time threshold in ms

// Results tracking
let resultsPerStep = [];

// Initialize test directories
const TEST_DIR = "stress_test_results";
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR);
}

const LOG_DIR = path.join(TEST_DIR, "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

// Helper function to get human-readable path name
function getReadablePath(path) {
  if (path === "/" || path === "") return "Home";

  // Remove leading slash and replace other slashes with spaces
  let readable = path.replace(/^\//, "").replace(/\//g, " / ");

  // Capitalize first letter of each word
  readable = readable.replace(/\b\w/g, (match) => match.toUpperCase());

  return readable;
}

// Random delay between min and max
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// Run a test step with a specific number of concurrent users
async function runTestStep(userCount) {
  console.log(`\n=== Starting test with ${userCount} concurrent users ===`);

  // Reset tracking variables for this step
  const stepResults = {
    userCount,
    startTime: Date.now(),
    endTime: null,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    responseTimeTotal: 0,
    avgResponseTime: 0,
    successRate: 0,
    requestsPerSecond: 0,
    responseTimeBuckets: {
      "< 500ms": 0,
      "500ms-1s": 0,
      "1s-3s": 0,
      "3s-5s": 0,
      "5s-10s": 0,
      "> 10s": 0,
    },
    errorTypes: {},
    statusCodeCounts: {},
    pathMetrics: {},
    errorsByPath: {},
  };

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

  // Create a queue of test tasks
  const testQueue = [];
  for (let userId = 1; userId <= userCount; userId++) {
    const browserTypeIndex = (userId - 1) % browsers.length;
    const browserType = browsers[browserTypeIndex];

    // Each user tests a random URL to simulate real traffic
    const randomUrl = allUrls[Math.floor(Math.random() * allUrls.length)];
    testQueue.push({ userId, url: randomUrl, browserType });
  }

  // Shuffle queue for more realistic load pattern
  for (let i = testQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [testQueue[i], testQueue[j]] = [testQueue[j], testQueue[i]];
  }

  // Set concurrency limit based on system capabilities
  const systemConcurrency = Math.max(2, Math.min(os.cpus().length * 2, 20));
  const concurrencyLimit = Math.min(systemConcurrency, userCount);

  console.log(
    `Testing ${allUrls.length} URLs with ${userCount} users (Concurrency: ${concurrencyLimit})`
  );

  // Process queue with concurrency limit
  const runningPromises = new Set();

  // Track start of actual testing
  const testStartTime = Date.now();

  // Process all tests in the queue
  while (testQueue.length > 0 || runningPromises.size > 0) {
    // Fill up to concurrency limit
    while (runningPromises.size < concurrencyLimit && testQueue.length > 0) {
      const test = testQueue.shift();

      const promise = testUrl(
        test.userId,
        test.url,
        test.browserType,
        stepResults
      )
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

  // Calculate final metrics for this step
  stepResults.endTime = Date.now();
  const testDurationSeconds = (stepResults.endTime - testStartTime) / 1000;

  stepResults.successRate =
    stepResults.totalRequests > 0
      ? Math.round(
          (stepResults.successfulRequests / stepResults.totalRequests) * 100
        )
      : 0;

  stepResults.avgResponseTime =
    stepResults.successfulRequests > 0
      ? Math.round(
          stepResults.responseTimeTotal / stepResults.successfulRequests
        )
      : 0;

  stepResults.requestsPerSecond =
    Math.round((stepResults.totalRequests / testDurationSeconds) * 100) / 100;

  // Create path-specific metrics summary
  for (const pathKey in stepResults.pathMetrics) {
    const pathData = stepResults.pathMetrics[pathKey];
    pathData.successRate =
      pathData.requests > 0
        ? Math.round((pathData.successes / pathData.requests) * 100)
        : 0;
    pathData.avgResponseTime =
      pathData.successes > 0
        ? Math.round(pathData.totalResponseTime / pathData.successes)
        : 0;
  }

  console.log(`\nCompleted test with ${userCount} users:`);
  console.log(`- Success rate: ${stepResults.successRate}%`);
  console.log(`- Avg response time: ${stepResults.avgResponseTime}ms`);
  console.log(`- Requests/second: ${stepResults.requestsPerSecond}`);

  return stepResults;
}

// Test a single URL with a user
async function testUrl(userId, url, browserType, results) {
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
  results.totalRequests++;

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

    // Request the page
    const startTime = Date.now();
    let response = null;
    let errorMessage = null;

    try {
      response = await page.goto(url, {
        timeout: 30000, // 30 second timeout
        waitUntil: "domcontentloaded",
      });
    } catch (error) {
      errorMessage = error.message;
    }

    const responseTime = Date.now() - startTime;

    // Extract domain and path for tracking
    const urlObj = new URL(url);
    const domain = urlObj.origin;
    const urlPath = urlObj.pathname || "/";
    const pathKey = domain + urlPath;

    // Initialize pathMetrics for this URL if needed
    if (!results.pathMetrics[pathKey]) {
      results.pathMetrics[pathKey] = {
        domain,
        path: urlPath,
        requests: 0,
        successes: 0,
        totalResponseTime: 0,
        successRate: 0,
        avgResponseTime: 0,
      };
    }

    // Update path metrics
    results.pathMetrics[pathKey].requests++;

    // Check if successful
    if (response && response.status() < 400) {
      results.successfulRequests++;
      results.responseTimeTotal += responseTime;
      results.pathMetrics[pathKey].successes++;
      results.pathMetrics[pathKey].totalResponseTime += responseTime;

      // Track response time in appropriate bucket
      if (responseTime < 500) {
        results.responseTimeBuckets["< 500ms"]++;
      } else if (responseTime < 1000) {
        results.responseTimeBuckets["500ms-1s"]++;
      } else if (responseTime < 3000) {
        results.responseTimeBuckets["1s-3s"]++;
      } else if (responseTime < 5000) {
        results.responseTimeBuckets["3s-5s"]++;
      } else if (responseTime < 10000) {
        results.responseTimeBuckets["5s-10s"]++;
      } else {
        results.responseTimeBuckets["> 10s"]++;
      }

      // Simulate real user interaction
      try {
        await page.mouse.move(100, 100);
        await page.evaluate(() => window.scrollBy(0, 300));
        await page.waitForTimeout(randomDelay(USER_DELAY_MIN, USER_DELAY_MAX));
      } catch (interactionError) {
        // Ignore interaction errors
      }
    } else {
      results.failedRequests++;

      // Track error information
      const statusCode = response ? response.status() : null;
      const errorType = statusCode
        ? `HTTP ${statusCode}`
        : errorMessage
        ? "JS Error"
        : "Unknown Error";

      // Track error by type
      if (!results.errorTypes[errorType]) {
        results.errorTypes[errorType] = { count: 0, examples: [] };
      }
      results.errorTypes[errorType].count++;

      // Keep a few examples per error type
      if (results.errorTypes[errorType].examples.length < 3) {
        results.errorTypes[errorType].examples.push({
          url,
          errorMessage: errorMessage || `Status code: ${statusCode}`,
        });
      }

      // Track status codes
      if (statusCode) {
        if (!results.statusCodeCounts[statusCode]) {
          results.statusCodeCounts[statusCode] = 0;
        }
        results.statusCodeCounts[statusCode]++;
      }

      // Track errors by path
      if (!results.errorsByPath[pathKey]) {
        results.errorsByPath[pathKey] = [];
      }

      // Keep at most 5 errors per path
      if (results.errorsByPath[pathKey].length < 5) {
        results.errorsByPath[pathKey].push({
          errorType,
          statusCode,
          errorMessage: errorMessage || `Status code: ${statusCode}`,
        });
      }
    }
  } catch (error) {
    results.failedRequests++;
  } finally {
    await browser.close();
  }
}

// Run capacity test with increasing load
async function runCapacityTest() {
  console.log("Starting website capacity test...");
  console.log(
    `System info: ${os.type()} ${os.release()}, ${
      os.cpus().length
    } CPUs, ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB RAM`
  );

  const overallStartTime = Date.now();
  let maxSupportedUsers = 0;
  let lastSuccessfulStep = null;

  // Test with increasing user counts
  for (
    let userCount = MIN_USERS;
    userCount <= MAX_USERS;
    userCount += STEP_SIZE
  ) {
    const stepResults = await runTestStep(userCount);
    resultsPerStep.push(stepResults);

    // Save individual step report
    const stepReportPath = path.join(
      TEST_DIR,
      `step_report_${userCount}_users.html`
    );
    generateStepReport(stepResults, stepReportPath);

    // Check if this step passed the thresholds
    if (
      stepResults.successRate >= THRESHOLD_SUCCESS &&
      stepResults.avgResponseTime <= THRESHOLD_RESPONSE
    ) {
      maxSupportedUsers = userCount;
      lastSuccessfulStep = stepResults;
      console.log(
        `✅ Test with ${userCount} users passed thresholds, continuing to next step.`
      );
    } else {
      console.log(
        `❌ Test with ${userCount} users failed thresholds: success rate = ${stepResults.successRate}%, response time = ${stepResults.avgResponseTime}ms`
      );
      // Break test if we've found the limit
      if (userCount > MIN_USERS) {
        break;
      }
    }
  }

  const overallEndTime = Date.now();
  const totalTestDuration = (overallEndTime - overallStartTime) / 1000;

  // Generate final capacity report
  const finalCapacity = lastSuccessfulStep ? maxSupportedUsers : 0;
  generateCapacityReport(finalCapacity, totalTestDuration);

  if (finalCapacity > 0) {
    console.log(`\n✅ Maximum supported concurrent users: ${finalCapacity}`);
    console.log(
      `   Success rate at max capacity: ${lastSuccessfulStep.successRate}%`
    );
    console.log(
      `   Avg response time at max capacity: ${lastSuccessfulStep.avgResponseTime}ms`
    );
  } else {
    console.log(
      `\n❌ Website could not handle even ${MIN_USERS} concurrent users at acceptable performance levels.`
    );
  }

  console.log(
    `\nTotal test duration: ${Math.floor(totalTestDuration / 60)}m ${Math.round(
      totalTestDuration % 60
    )}s`
  );
  console.log(`Reports saved to ${TEST_DIR} directory.`);
}

// Generate step report for each user level tested
function generateStepReport(stepResults, filePath) {
  // Format metrics for this step
  const pathMetrics = [];
  for (const pathKey in stepResults.pathMetrics) {
    const metric = stepResults.pathMetrics[pathKey];
    pathMetrics.push({
      domain: metric.domain,
      path: metric.path,
      requests: metric.requests,
      successRate: metric.successRate,
      avgResponseTime: metric.avgResponseTime,
      hasErrors: stepResults.errorsByPath[pathKey] ? true : false,
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
  const sortedErrorTypes = Object.entries(stepResults.errorTypes || {})
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, data]) => ({ type, ...data }));

  // Sort status codes by frequency
  const sortedStatusCodes = Object.entries(stepResults.statusCodeCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, count }));

  const testDurationSeconds =
    (stepResults.endTime - stepResults.startTime) / 1000;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Step Report - ${stepResults.userCount} Users</title>
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
    .threshold-status {
      padding: 15px;
      border-radius: 8px;
      margin-top: 30px;
      margin-bottom: 30px;
      text-align: center;
    }
    .threshold-passed {
      background-color: #d4edda;
      border: 1px solid #c3e6cb;
      color: #155724;
    }
    .threshold-failed {
      background-color: #f8d7da;
      border: 1px solid #f5c6cb;
      color: #721c24;
    }
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
  </style>
</head>
<body>
  <div class="container">
    <h1>Load Test Results: ${stepResults.userCount} Concurrent Users</h1>
    
    <div class="test-info">
      <div class="test-info-header">Test Configuration</div>
      <div class="test-stats">
        <div class="test-stat">
          <div class="test-stat-label">Concurrent Users</div>
          <div class="test-stat-value">${stepResults.userCount}</div>
        </div>
        <div class="test-stat">
          <div class="test-stat-label">URLs Tested</div>
          <div class="test-stat-value">${
            Object.keys(stepResults.pathMetrics).length
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
          <div class="test-stat-value">${new Date(
            stepResults.endTime
          ).toLocaleString()}</div>
        </div>
      </div>
    </div>
    
    <div class="threshold-status ${
      stepResults.successRate >= THRESHOLD_SUCCESS &&
      stepResults.avgResponseTime <= THRESHOLD_RESPONSE
        ? "threshold-passed"
        : "threshold-failed"
    }">
      <h2 style="margin-top: 0; border-bottom: none;">Threshold Check</h2>
      <p>
        <strong>Success Rate:</strong> ${stepResults.successRate}% 
        ${
          stepResults.successRate >= THRESHOLD_SUCCESS ? "✅" : "❌"
        } (Threshold: ${THRESHOLD_SUCCESS}%)
      </p>
      <p>
        <strong>Response Time:</strong> ${stepResults.avgResponseTime}ms 
        ${
          stepResults.avgResponseTime <= THRESHOLD_RESPONSE ? "✅" : "❌"
        } (Threshold: ${THRESHOLD_RESPONSE}ms)
      </p>
      <p>
        <strong>Result:</strong> ${
          stepResults.successRate >= THRESHOLD_SUCCESS &&
          stepResults.avgResponseTime <= THRESHOLD_RESPONSE
            ? "PASSED - This load level is acceptable"
            : "FAILED - This load level exceeds website capacity"
        }
      </p>
    </div>
    
    <div class="summary">
      <div class="metric-card">
        <div class="metric-label">Total Requests</div>
        <div class="metric-value">${stepResults.totalRequests}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Success Rate</div>
        <div class="metric-value">${stepResults.successRate}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Failed Requests</div>
        <div class="metric-value">${stepResults.failedRequests}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Requests/Second</div>
        <div class="metric-value">${stepResults.requestsPerSecond}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Avg Response Time</div>
        <div class="metric-value">${stepResults.avgResponseTime}ms</div>
      </div>
    </div>
    
    <h2>Response Time Distribution</h2>
    
    <div class="response-time-bars">
      ${Object.entries(stepResults.responseTimeBuckets)
        .map(([label, count]) => {
          const percentage =
            stepResults.successfulRequests > 0
              ? Math.round((count / stepResults.successfulRequests) * 100)
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
                        metric.hasErrors && stepResults.errorsByPath[pathKey]
                          ? `
                        <details>
                          <summary>View Errors</summary>
                          ${stepResults.errorsByPath[pathKey]
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

  fs.writeFileSync(filePath, html);
  console.log(
    `Step report for ${stepResults.userCount} users saved to ${filePath}`
  );
}

// Generate final capacity report
function generateCapacityReport(maxCapacity, totalDuration) {
  // Create capacity summary from all steps
  const capacityData = resultsPerStep.map((step) => ({
    users: step.userCount,
    successRate: step.successRate,
    responseTime: step.avgResponseTime,
    requestsPerSecond: step.requestsPerSecond,
    passed:
      step.successRate >= THRESHOLD_SUCCESS &&
      step.avgResponseTime <= THRESHOLD_RESPONSE,
  }));

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Website Capacity Report</title>
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
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background-color: #fff;
      border-radius: 10px;
      padding: 30px;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
    }
    .capacity-result {
      text-align: center;
      padding: 30px;
      margin: 30px 0;
      background-color: ${maxCapacity > 0 ? "#d4edda" : "#f8d7da"};
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .capacity-number {
      font-size: 5em;
      font-weight: bold;
      color: ${maxCapacity > 0 ? "#28a745" : "#dc3545"};
      margin: 10px 0;
    }
    .capacity-label {
      font-size: 1.2em;
      color: #555;
      max-width: 600px;
      margin: 0 auto;
    }
    .steps-summary {
      margin: 30px 0;
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
    tr.passed {
      background-color: rgba(40, 167, 69, 0.1);
    }
    tr.failed {
      background-color: rgba(220, 53, 69, 0.1);
    }
    .threshold-info {
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 25px;
      background-color: #e9ecef;
    }
    .threshold-title {
      font-weight: bold;
      margin-bottom: 10px;
    }
    .threshold-item {
      margin: 8px 0;
    }
    .chart-container {
      height: 400px;
      margin: 30px 0;
    }
    canvas {
      width: 100%;
      height: 100%;
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
    .conclusion {
      padding: 20px;
      background-color: #f8f9fa;
      border-radius: 8px;
      margin-top: 30px;
    }
    .conclusion-title {
      font-weight: bold;
      margin-bottom: 10px;
      font-size: 1.1em;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <h1>Website Capacity Report</h1>
    
    <div class="test-info">
      <div class="test-info-header">Test Information</div>
      <p><strong>Test Start:</strong> ${new Date(
        resultsPerStep[0].startTime
      ).toLocaleString()}</p>
      <p><strong>Test Completion:</strong> ${new Date(
        resultsPerStep[resultsPerStep.length - 1].endTime
      ).toLocaleString()}</p>
      <p><strong>Total Duration:</strong> ${Math.floor(
        totalDuration / 60
      )}m ${Math.round(totalDuration % 60)}s</p>
      <p><strong>Steps Tested:</strong> ${resultsPerStep.length}</p>
      <p><strong>Step Size:</strong> ${STEP_SIZE} users</p>
      <p><strong>User Range:</strong> ${MIN_USERS} to ${
    resultsPerStep[resultsPerStep.length - 1].userCount
  } users</p>
    </div>
    
    <div class="threshold-info">
      <div class="threshold-title">Capacity Thresholds</div>
      <div class="threshold-item"><strong>Success Rate:</strong> ${THRESHOLD_SUCCESS}% or higher</div>
      <div class="threshold-item"><strong>Response Time:</strong> ${THRESHOLD_RESPONSE}ms or lower</div>
    </div>
    
    <div class="capacity-result">
      <h2 style="margin-top: 0; border-bottom: none;">Maximum Supported Concurrent Users</h2>
      <div class="capacity-number">${maxCapacity || "N/A"}</div>
      <div class="capacity-label">
        ${
          maxCapacity > 0
            ? `The website can reliably support ${maxCapacity} concurrent users while maintaining a ${THRESHOLD_SUCCESS}% success rate and response time under ${THRESHOLD_RESPONSE}ms.`
            : `The website could not support even ${MIN_USERS} concurrent users at acceptable performance levels.`
        }
      </div>
    </div>
    
    <div class="chart-container">
      <canvas id="performanceChart"></canvas>
    </div>
    
    <h2>Test Steps Summary</h2>
    
    <div class="steps-summary">
      <table>
        <thead>
          <tr>
            <th>Users</th>
            <th>Success Rate</th>
            <th>Avg Response Time</th>
            <th>Requests/Second</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${capacityData
            .map(
              (data) => `
            <tr class="${data.passed ? "passed" : "failed"}">
              <td>${data.users}</td>
              <td>${data.successRate}%</td>
              <td>${data.responseTime}ms</td>
              <td>${data.requestsPerSecond}</td>
              <td>${data.passed ? "✅ PASSED" : "❌ FAILED"}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
    
    <div class="conclusion">
      <div class="conclusion-title">Conclusion</div>
      <p>
        ${
          maxCapacity > 0
            ? `Based on the test results, the website demonstrates stable performance with up to <strong>${maxCapacity}</strong> concurrent users. 
             At this load level, the success rate is maintained above ${THRESHOLD_SUCCESS}% and the average response time stays below ${THRESHOLD_RESPONSE}ms.
             Attempting to serve more than ${maxCapacity} users simultaneously results in degraded performance that falls below acceptable thresholds.`
            : `The website could not maintain acceptable performance even at the minimum test level of ${MIN_USERS} concurrent users. 
             This suggests significant performance issues that should be addressed before the site is deployed for production use.`
        }
      </p>
      <p>For detailed results at each load level, please refer to the individual step reports in the same directory.</p>
    </div>
    
    <div style="margin-top: 20px; text-align: center; color: #777; font-size: 12px;">
      <p>System: ${os.type()} ${os.release()}, ${
    os.cpus().length
  } CPUs, ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB RAM</p>
      <p>Generated on ${new Date().toLocaleString()}</p>
    </div>
  </div>
  
  <script>
    // Create performance chart
    const ctx = document.getElementById('performanceChart').getContext('2d');
    const data = ${JSON.stringify(capacityData)};
    
    const maxUserCount = ${MAX_USERS};
    const responseTimeThreshold = ${THRESHOLD_RESPONSE};
    const successRateThreshold = ${THRESHOLD_SUCCESS};
    
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(item => item.users + ' Users'),
        datasets: [
          {
            label: 'Success Rate (%)',
            data: data.map(item => item.successRate),
            borderColor: 'rgba(40, 167, 69, 1)',
            backgroundColor: 'rgba(40, 167, 69, 0.1)',
            yAxisID: 'y',
            tension: 0.1
          },
          {
            label: 'Response Time (ms)',
            data: data.map(item => item.responseTime),
            borderColor: 'rgba(0, 123, 255, 1)',
            backgroundColor: 'rgba(0, 123, 255, 0.1)',
            yAxisID: 'y1',
            tension: 0.1
          }
        ]
      },
      options: {
        responsive: true,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        scales: {
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: {
              display: true,
              text: 'Success Rate (%)'
            },
            min: 0,
            max: 100,
            grid: {
              color: 'rgba(0, 0, 0, 0.05)'
            }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: {
              display: true,
              text: 'Response Time (ms)'
            },
            min: 0,
            grid: {
              drawOnChartArea: false
            }
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              footer: function(tooltipItems) {
                const item = tooltipItems[0];
                const dataIndex = item.dataIndex;
                const users = data[dataIndex].users;
                return 'Status: ' + (data[dataIndex].passed ? 'PASSED' : 'FAILED');
              }
            }
          },
          annotation: {
            annotations: {
              successThreshold: {
                type: 'line',
                yMin: successRateThreshold,
                yMax: successRateThreshold,
                borderColor: 'rgba(40, 167, 69, 0.5)',
                borderWidth: 2,
                borderDash: [6, 6],
                label: {
                  enabled: true,
                  content: 'Success Threshold: ' + successRateThreshold + '%',
                  position: 'end',
                  backgroundColor: 'rgba(40, 167, 69, 0.7)'
                }
              },
              responseThreshold: {
                type: 'line',
                yMin: responseTimeThreshold,
                yMax: responseTimeThreshold,
                scaleID: 'y1',
                borderColor: 'rgba(220, 53, 69, 0.5)',
                borderWidth: 2,
                borderDash: [6, 6],
                label: {
                  enabled: true,
                  content: 'Response Time Threshold: ' + responseTimeThreshold + 'ms',
                  position: 'end',
                  backgroundColor: 'rgba(220, 53, 69, 0.7)'
                }
              }
            }
          }
        }
      }
    });
  </script>
</body>
</html>
  `;

  const reportPath = path.join(TEST_DIR, "capacity_report.html");
  fs.writeFileSync(reportPath, html);
  console.log(`Final capacity report saved to ${reportPath}`);
}

// Run the capacity test
runCapacityTest().catch(console.error);
