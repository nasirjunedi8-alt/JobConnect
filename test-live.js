require('dotenv').config();

const crypto = require('crypto');

const baseUrlSetting = process.env.LIVE_BASE_URL || process.env.RENDER_URL;
const adminMobile = process.env.BOOTSTRAP_ADMIN_MOBILE;
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const checks = [];
let halted = false;

async function runCheck(name, action) {
  if (halted) {
    checks.push({ name, status: 'SKIP', detail: 'A prerequisite check failed' });
    return;
  }
  try {
    await action();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message });
    halted = true;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeMobile() {
  return `9${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

function makeTestAccount(role, label) {
  const id = crypto.randomUUID();
  const mobile = makeMobile();
  const password = `JCtest${crypto.randomBytes(12).toString('hex')}X1`;
  return {
    role,
    name: `Render ${label} ${id.slice(0, 8)}`,
    mobile,
    email: `jobconnect-${label}-${id}@example.test`,
    password,
    ...(role === 'comp' ? { cn: `Render Test Company ${id.slice(0, 8)}` } : {})
  };
}

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Expected JSON response; received HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${data.error || 'API request failed'}`);
  }
  return data;
}

async function main() {
  let adminToken;
  let employer;
  let employerToken;
  let candidate;
  let candidateToken;
  let job;
  let application;

  await runCheck('Configuration', async () => {
    assert(baseUrlSetting, 'Set LIVE_BASE_URL or RENDER_URL to the Render service URL');
    let parsedUrl;
    try {
      parsedUrl = new URL(baseUrlSetting);
    } catch {
      throw new Error('Render URL must be a valid absolute URL');
    }
    assert(['http:', 'https:'].includes(parsedUrl.protocol), 'Render URL must use HTTP or HTTPS');
    assert(!parsedUrl.username && !parsedUrl.password, 'Render URL must not contain embedded credentials');
    assert(adminMobile && /^\d{10}$/.test(adminMobile), 'Set BOOTSTRAP_ADMIN_MOBILE to a 10-digit number');
    assert(adminPassword, 'Set BOOTSTRAP_ADMIN_PASSWORD');
    baseUrl = parsedUrl.toString().replace(/\/+$/, '');
  });

  await runCheck('Admin login', async () => {
    const result = await request('/api/login', {
      method: 'POST',
      body: { id: adminMobile, password: adminPassword }
    });
    assert(result.token && result.user && result.user.r === 'adm', 'Admin login response was invalid');
    adminToken = result.token;
  });

  await runCheck('Register Employer', async () => {
    employer = makeTestAccount('comp', 'employer');
    const result = await request('/api/register', { method: 'POST', body: employer });
    assert(result.user && result.user.r === 'comp', 'Employer registration response was invalid');
    employer.id = result.user.id;
  });

  await runCheck('Register Job Seeker', async () => {
    candidate = makeTestAccount('cand', 'candidate');
    const result = await request('/api/register', { method: 'POST', body: candidate });
    assert(result.user && result.user.r === 'cand', 'Job Seeker registration response was invalid');
    candidate.id = result.user.id;
  });

  await runCheck('Employer and Job Seeker login', async () => {
    const [employerResult, candidateResult] = await Promise.all([
      request('/api/login', { method: 'POST', body: { id: employer.mobile, password: employer.password } }),
      request('/api/login', { method: 'POST', body: { id: candidate.mobile, password: candidate.password } })
    ]);
    assert(employerResult.token && employerResult.user.r === 'comp', 'Employer login response was invalid');
    assert(candidateResult.token && candidateResult.user.r === 'cand', 'Job Seeker login response was invalid');
    employerToken = employerResult.token;
    candidateToken = candidateResult.token;
  });

  await runCheck('Admin users and jobs endpoint', async () => {
    const result = await request('/api/admin/users', { token: adminToken });
    assert(Array.isArray(result.users) && Array.isArray(result.jobs), 'Admin endpoint did not return users and jobs');
    assert(result.users.some(user => user.id === employer.id), 'New Employer was not listed by admin endpoint');
    assert(result.users.some(user => user.id === candidate.id), 'New Job Seeker was not listed by admin endpoint');
  });

  await runCheck('Admin company verification', async () => {
    const result = await request(`/api/verify-company/${encodeURIComponent(employer.id)}`, {
      method: 'POST',
      token: adminToken
    });
    assert(result.verified === true && result.user && result.user.id === employer.id, 'Company was not verified');
  });

  await runCheck('Employer posts a job', async () => {
    const result = await request('/api/jobs', {
      method: 'POST',
      token: employerToken,
      body: {
        title: `Render test role ${crypto.randomUUID().slice(0, 8)}`,
        city: 'Bijapur',
        industry: 'Software',
        vacancies: 1
      }
    });
    assert(result.job && result.job.id && result.job.status === 'Active', 'Job posting response was invalid');
    job = result.job;
  });

  await runCheck('Job Seeker applies', async () => {
    const result = await request('/api/apply', {
      method: 'POST',
      token: candidateToken,
      body: { jobId: job.id }
    });
    assert(result.application && result.application.jobId === job.id, 'Application response was invalid');
    application = result.application;
  });

  await runCheck('Employer notifications', async () => {
    const result = await request('/api/notifications', { token: employerToken });
    assert(Array.isArray(result.notifications), 'Notifications endpoint did not return a list');
    assert(
      result.notifications.some(notification => notification.title.includes(job.title)),
      'Employer did not receive the new applicant notification'
    );
  });

  await runCheck('Application appears in Employer inbox', async () => {
    const result = await request('/api/applications', { token: employerToken });
    assert(
      Array.isArray(result.applications) && result.applications.some(item => item.id === application.id),
      'Application was not returned to the Employer'
    );
  });

  console.log(`\nJobConnect live API test report (${baseUrl || 'configuration unavailable'})`);
  console.log('Note: successful runs create persistent test accounts, a job, an application, and notifications.');
  for (const check of checks) {
    console.log(`${check.status.padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  const passed = checks.filter(check => check.status === 'PASS').length;
  const failed = checks.filter(check => check.status === 'FAIL').length;
  const skipped = checks.filter(check => check.status === 'SKIP').length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed) process.exitCode = 1;
}

let baseUrl = '';
main().catch(error => {
  console.error(`Test runner failed: ${error.message}`);
  process.exitCode = 1;
});
