require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const DB_DIR = path.dirname(DB_FILE);
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const pool = USE_POSTGRES
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(process.env.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {})
  })
  : null;
const MAX_BODY = 5 * 1024 * 1024;
const MOB = /^\d{10}$/;
const EML = /^\S+@\S+\.\S+$/;
const PW = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
const EXTRA = ['l', 'q', 'ex', 'sk', 'ind', 'dept', 'empid', 'dob', 'gender', 'stream', 'year', 'cn', 'resume'];
const otpChallenges = new Map();
const resetChallenges = new Map();
const rateLimits = new Map();

let db = { users: [], sessions: {}, jobs: [], applications: [], notifications: [] };
let persistenceQueue = Promise.resolve();
const normalizeDb = value => ({
  users: Array.isArray(value.users) ? value.users : [],
  sessions: value.sessions || {},
  jobs: Array.isArray(value.jobs) ? value.jobs : [],
  applications: Array.isArray(value.applications) ? value.applications : [],
  notifications: Array.isArray(value.notifications) ? value.notifications : []
});
const persistPostgres = async snapshot => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['notifications', 'applications', 'jobs', 'users', 'sessions']) {
      await client.query(`DELETE FROM ${table}`);
    }
    for (const user of snapshot.users) {
      await client.query(
        'INSERT INTO users (id, mobile, email, data) VALUES ($1, $2, $3, $4::jsonb)',
        [user.id, user.ph, user.em || null, JSON.stringify(user)]
      );
    }
    for (const job of snapshot.jobs) {
      await client.query('INSERT INTO jobs (id, data) VALUES ($1, $2::jsonb)', [job.id, JSON.stringify(job)]);
    }
    for (const application of snapshot.applications) {
      await client.query(
        'INSERT INTO applications (id, data) VALUES ($1, $2::jsonb)',
        [application.id, JSON.stringify(application)]
      );
    }
    for (const notification of snapshot.notifications) {
      await client.query(
        'INSERT INTO notifications (id, user_id, data) VALUES ($1, $2, $3::jsonb)',
        [notification.id, notification.userId, JSON.stringify(notification)]
      );
    }
    for (const [token, userId] of Object.entries(snapshot.sessions)) {
      await client.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
const save = () => {
  if (!pool) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return Promise.resolve();
  }
  const snapshot = JSON.parse(JSON.stringify(db));
  persistenceQueue = persistenceQueue.catch(() => {}).then(() => persistPostgres(snapshot));
  return persistenceQueue;
};
async function initializeStorage() {
  if (!pool) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      db = normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    }
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      mobile TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, data JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  `);
  const [users, jobs, applications, notifications, sessions] = await Promise.all([
    pool.query('SELECT data FROM users'),
    pool.query('SELECT data FROM jobs'),
    pool.query('SELECT data FROM applications'),
    pool.query('SELECT data FROM notifications'),
    pool.query('SELECT token, user_id FROM sessions')
  ]);
  db = normalizeDb({
    users: users.rows.map(row => row.data),
    jobs: jobs.rows.map(row => row.data),
    applications: applications.rows.map(row => row.data),
    notifications: notifications.rows.map(row => row.data),
    sessions: Object.fromEntries(sessions.rows.map(row => [row.token, row.user_id]))
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pub = user => {
  const { pw, ...rest } = user;
  return rest;
};
const send = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((resolve, reject) => {
  let data = '';
  let rejected = false;
  req.on('data', chunk => {
    if (rejected) return;
    data += chunk;
    if (data.length > MAX_BODY) {
      rejected = true;
      reject(new HttpError(413, 'Request too large'));
    }
  });
  req.on('end', () => {
    if (rejected) return;
    try {
      resolve(data ? JSON.parse(data) : {});
    } catch {
      reject(new HttpError(400, 'Invalid JSON'));
    }
  });
  req.on('error', reject);
});
const authUser = req => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = db.sessions[token];
  return db.users.find(user => user.id === userId) || null;
};
const requireUser = req => {
  const user = authUser(req);
  if (!user) throw new HttpError(401, 'Please log in');
  if (user.b) throw new HttpError(403, 'Your account is blocked');
  return user;
};
const requireRole = (req, roles) => {
  const user = requireUser(req);
  if (!roles.includes(user.r)) throw new HttpError(403, 'You are not allowed to perform this action');
  return user;
};
const addNotification = (userId, title, lines = []) => {
  db.notifications.unshift({
    id: crypto.randomUUID(),
    userId,
    title,
    lines,
    createdAt: Date.now(),
    read: false
  });
};
const getJob = id => db.jobs.find(job => job.id === id);
const getApplication = id => db.applications.find(application => application.id === id);
const publicJob = job => {
  const company = db.users.find(user => user.id === job.companyId);
  return {
    id: job.id,
    title: job.title,
    city: job.city,
    industry: job.industry,
    companyId: job.companyId,
    companyName: company ? (company.cn || company.n) : job.companyName,
    companyMobile: company ? company.ph : '',
    companyEmail: company ? company.em : '',
    companyLocation: company ? (company.l || '') : '',
    companyEmployees: company ? (company.ex || '') : '',
    vacancies: job.vacancies,
    status: job.status,
    createdAt: job.createdAt,
    applicantCount: db.applications.filter(application => application.jobId === job.id).length
  };
};
const publicApplication = application => {
  const job = getJob(application.jobId);
  const candidate = db.users.find(user => user.id === application.candidateId);
  if (!job || !candidate) return null;
  return {
    id: application.id,
    jobId: application.jobId,
    status: application.status,
    createdAt: application.createdAt,
    job: publicJob(job),
    candidate: {
      id: candidate.id,
      name: candidate.n,
      mobile: candidate.ph,
      email: candidate.em,
      location: candidate.l || '',
      qualification: candidate.q || '',
      skills: candidate.sk || '',
      experience: candidate.ex || '',
      resume: candidate.resume || ''
    }
  };
};
const limitRequest = (key, limit, duration) => {
  const now = Date.now();
  let item = rateLimits.get(key);
  if (!item || item.expiresAt <= now) {
    item = { count: 0, expiresAt: now + duration };
    rateLimits.set(key, item);
  }
  item.count += 1;
  return item.count <= limit;
};
const clientIp = req => req.socket.remoteAddress || 'unknown';
const passwordHash = password => bcrypt.hash(password, 12);
const matchesPassword = async (password, stored) => {
  if (stored.startsWith('$2')) return bcrypt.compare(password, stored);
  const [salt, ...rest] = stored.split(':');
  const expected = rest.join(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return true;
};
const normalizeMobile = value => String(value || '').replace(/\s|\+91/g, '');
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const randomToken = () => crypto.randomBytes(32).toString('hex');

async function sendOtp(email, otp) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: 'JobConnect password reset OTP',
      text: `Your JobConnect password reset code is ${otp}. It expires in 10 minutes.`
    });
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new HttpError(503, 'Password reset email is not configured');
  }
  console.log(`Development password-reset OTP for ${email}: ${otp}`);
}

async function seedAdmin() {
  const mobileSetting = process.env.BOOTSTRAP_ADMIN_MOBILE;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!mobileSetting && !password) return;
  if (!mobileSetting || !password) {
    throw new Error('Set both BOOTSTRAP_ADMIN_MOBILE and BOOTSTRAP_ADMIN_PASSWORD to create the owner admin account');
  }

  const nameSetting = process.env.BOOTSTRAP_ADMIN_NAME;
  const emailSetting = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const name = nameSetting ? nameSetting.trim() : '';
  const mobile = normalizeMobile(process.env.BOOTSTRAP_ADMIN_MOBILE);
  const email = emailSetting ? normalizeEmail(emailSetting) : '';
  if (!MOB.test(mobile) || (emailSetting && !EML.test(email)) || !PW.test(password)) {
    throw new Error('Owner admin needs a valid 10-digit mobile, optional valid email, and password with 8+ letters/numbers');
  }
  const existingByMobile = db.users.find(user => user.ph === mobile);
  const existingByEmail = email ? db.users.find(user => user.em === email) : null;
  if (existingByMobile && existingByEmail && existingByMobile !== existingByEmail) {
    throw new Error('Owner admin mobile and email belong to different accounts');
  }
  const existing = existingByMobile || existingByEmail;
  if (existing && existing.r !== 'adm') {
    throw new Error('Owner admin mobile/email already belongs to a different account');
  }
  const user = existing || { id: crypto.randomUUID(), createdAt: Date.now(), b: 0 };
  Object.assign(user, {
    r: 'adm',
    n: name || user.n || 'Government Admin',
    ph: mobile,
    em: email || user.em || '',
    pw: await passwordHash(password),
    v: 1
  });
  if (!existing) db.users.push(user);
  await save();
}

async function api(req, res, url) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, users: db.users.length });
  }

  if (url === '/api/jobs' && req.method === 'GET') {
    const user = requireRole(req, ['cand', 'comp', 'adm']);
    const visibleJobs = db.jobs.filter(job => {
      if (user.r === 'adm') return true;
      if (user.r === 'comp') return job.companyId === user.id;
      const company = db.users.find(item => item.id === job.companyId);
      return job.status === 'Active' && company && company.r === 'comp' && company.v && !company.b;
    });
    return send(res, 200, { jobs: visibleJobs.map(publicJob) });
  }

  if (url === '/api/jobs' && req.method === 'POST') {
    const company = requireRole(req, ['comp']);
    if (!company.v) throw new HttpError(403, 'Your company must be verified before posting jobs');
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const city = String(body.city || '').trim();
    const industry = String(body.industry || '').trim();
    const vacancies = body.vacancies === undefined ? 1 : Number(body.vacancies);
    if (!title || title.length > 150) throw new HttpError(400, 'Enter a job title (maximum 150 characters)');
    if (!city || city.length > 100) throw new HttpError(400, 'Enter a valid city');
    if (!industry || industry.length > 100) throw new HttpError(400, 'Enter a valid industry');
    if (!Number.isInteger(vacancies) || vacancies < 1 || vacancies > 10000) {
      throw new HttpError(400, 'Vacancies must be a positive whole number');
    }
    const job = {
      id: crypto.randomUUID(),
      companyId: company.id,
      title,
      city,
      industry,
      vacancies,
      status: 'Active',
      createdAt: Date.now()
    };
    db.jobs.unshift(job);
    await save();
    return send(res, 201, { job: publicJob(job) });
  }

  if (url === '/api/apply' && req.method === 'POST') {
    const candidate = requireRole(req, ['cand']);
    const body = await readBody(req);
    const jobId = String(body.jobId || '');
    const job = getJob(jobId);
    const company = job && db.users.find(user => user.id === job.companyId);
    if (!job || job.status !== 'Active' || !company || !company.v || company.b) {
      throw new HttpError(404, 'This job is no longer available');
    }
    if (db.applications.some(application => application.jobId === jobId && application.candidateId === candidate.id)) {
      throw new HttpError(409, 'You have already applied to this job');
    }
    const application = {
      id: crypto.randomUUID(),
      jobId,
      candidateId: candidate.id,
      status: 'New',
      createdAt: Date.now()
    };
    db.applications.unshift(application);
    addNotification(company.id, `New applicant: ${job.title}`, [
      `Name: ${candidate.n}`,
      `Mobile: +91 ${candidate.ph}`,
      `Email: ${candidate.em}`,
      `Location: ${candidate.l || '-'}`,
      `Qualification: ${candidate.q || '-'}`,
      `Skills: ${candidate.sk || '-'}`
    ]);
    await save();
    return send(res, 201, { application: publicApplication(application) });
  }

  if (url === '/api/applications' && req.method === 'GET') {
    const user = requireRole(req, ['cand', 'comp', 'adm']);
    const applications = db.applications.filter(application => {
      if (user.r === 'adm') return true;
      if (user.r === 'cand') return application.candidateId === user.id;
      const job = getJob(application.jobId);
      return job && job.companyId === user.id;
    }).map(publicApplication).filter(Boolean);
    return send(res, 200, { applications });
  }

  const shortlistMatch = url.match(/^\/api\/shortlist\/([^/]+)$/);
  if (shortlistMatch && req.method === 'POST') {
    const company = requireRole(req, ['comp']);
    const application = getApplication(decodeURIComponent(shortlistMatch[1]));
    const job = application && getJob(application.jobId);
    if (!application || !job || job.companyId !== company.id) {
      throw new HttpError(404, 'Application not found');
    }
    application.status = 'Shortlisted';
    const candidate = db.users.find(user => user.id === application.candidateId);
    if (candidate) {
      addNotification(candidate.id, `🎉 You were shortlisted for ${job.title}`, [
        `Company: ${company.cn || company.n}`,
        `City: ${job.city}`,
        `Industry: ${job.industry}`
      ]);
    }
    await save();
    return send(res, 200, { application: publicApplication(application) });
  }

  const rejectMatch = url.match(/^\/api\/reject\/([^/]+)$/);
  if (rejectMatch && req.method === 'POST') {
    const company = requireRole(req, ['comp']);
    const application = getApplication(decodeURIComponent(rejectMatch[1]));
    const job = application && getJob(application.jobId);
    if (!application || !job || job.companyId !== company.id) {
      throw new HttpError(404, 'Application not found');
    }
    application.status = 'Rejected';
    const candidate = db.users.find(user => user.id === application.candidateId);
    if (candidate) addNotification(candidate.id, `Application update: ${job.title}`, [
      `${company.cn || company.n} did not select your application this time.`
    ]);
    await save();
    return send(res, 200, { application: publicApplication(application) });
  }

  if (url === '/api/admin/users' && req.method === 'GET') {
    requireRole(req, ['adm']);
    return send(res, 200, {
      users: db.users.map(pub),
      jobs: db.jobs.map(publicJob)
    });
  }

  if (url === '/api/users' && req.method === 'GET') {
    requireRole(req, ['adm']);
    return send(res, 200, { users: db.users.map(pub) });
  }

  const verifyMatch = url.match(/^\/api\/verify-company\/([^/]+)$/);
  if (verifyMatch && req.method === 'POST') {
    requireRole(req, ['adm']);
    const company = db.users.find(user => user.id === decodeURIComponent(verifyMatch[1]) && user.r === 'comp');
    if (!company) throw new HttpError(404, 'Company not found');
    company.v = company.v ? 0 : 1;
    addNotification(
      company.id,
      company.v ? '✅ Your company is verified' : 'Your company verification was revoked',
      [company.v ? 'Your company can now post jobs.' : 'Your company can no longer post jobs.']
    );
    await save();
    return send(res, 200, { user: pub(company), verified: !!company.v });
  }

  if (url === '/api/notifications' && req.method === 'GET') {
    const user = requireUser(req);
    const notifications = db.notifications
      .filter(notification => notification.userId === user.id)
      .map(({ id, title, lines, createdAt, read }) => ({ id, title, lines, createdAt, read }));
    return send(res, 200, { notifications });
  }

  if (url === '/api/notifications/read' && req.method === 'POST') {
    const user = requireUser(req);
    db.notifications
      .filter(notification => notification.userId === user.id)
      .forEach(notification => { notification.read = true; });
    await save();
    return send(res, 200, { ok: true });
  }

  if (url === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    const role = body.role;
    const name = String(body.name || '').trim();
    const mobile = normalizeMobile(body.mobile);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (role === 'adm') throw new HttpError(403, 'Admin accounts are provisioned by the owner');
    if (!['cand', 'comp'].includes(role)) throw new HttpError(400, 'Choose a valid role');
    if (!name) throw new HttpError(400, 'Enter your name');
    if (!MOB.test(mobile)) throw new HttpError(400, 'Enter a 10-digit mobile number');
    if (!EML.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (!PW.test(password)) throw new HttpError(400, 'Password needs 8+ characters with letters and numbers');
    if (db.users.some(user => user.ph === mobile || user.em === email)) {
      throw new HttpError(409, 'Mobile number or email is already registered');
    }
    const user = {
      id: crypto.randomUUID(),
      r: role,
      n: name,
      ph: mobile,
      em: email,
      pw: await passwordHash(password),
      createdAt: Date.now(),
      b: 0
    };
    if (role === 'comp') user.v = 0;
    EXTRA.forEach(key => {
      if (body[key] !== undefined) user[key] = String(body[key]).slice(0, key === 'resume' ? 200 : 300);
    });
    if (body.photo !== undefined) {
      const photo = String(body.photo);
      if (photo.length > 700000 || !/^data:image\/(?:jpeg|png);base64,/.test(photo)) {
        throw new HttpError(400, 'Photo must be a JPG or PNG smaller than 2MB');
      }
      user.photo = photo;
    }
    db.users.push(user);
    await save();
    return send(res, 201, { user: pub(user) });
  }

  if (url === '/api/login' && req.method === 'POST') {
    if (!limitRequest(`login:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Too many login attempts. Please try again later.');
    }
    const body = await readBody(req);
    const id = String(body.id || '').replace(/\s|\+91/g, '').toLowerCase();
    const user = db.users.find(item => item.ph === id || item.em === id);
    if (!user || !await matchesPassword(String(body.password || ''), user.pw)) {
      throw new HttpError(401, 'Incorrect number/email or password');
    }
    if (user.b) throw new HttpError(403, 'Your account is blocked');
    if (!user.pw.startsWith('$2')) {
      user.pw = await passwordHash(String(body.password || ''));
    }
    const token = randomToken();
    db.sessions[token] = user.id;
    await save();
    return send(res, 200, { token, user: pub(user) });
  }

  if (url === '/api/me' && req.method === 'GET') {
    const user = authUser(req);
    return user
      ? send(res, 200, { user: pub(user) })
      : send(res, 401, { error: 'Please log in' });
  }

  if (url === '/api/logout' && req.method === 'POST') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    delete db.sessions[token];
    await save();
    return send(res, 200, { ok: true });
  }

  if (url === '/api/forgot-password' && req.method === 'POST') {
    const body = await readBody(req);
    const mobile = normalizeMobile(body.mobile);
    if (!MOB.test(mobile)) throw new HttpError(400, 'Enter a 10-digit mobile number');
    const smtpConfigured = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].every(key => process.env[key]);
    if (process.env.NODE_ENV === 'production' && !smtpConfigured) {
      throw new HttpError(503, 'Password reset email is not configured');
    }
    if (!limitRequest(`otp-send-ip:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Too many OTP requests. Please try again later.');
    }
    if (!limitRequest(`otp-send:${clientIp(req)}:${mobile}`, 3, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Too many OTP requests. Please try again later.');
    }
    const user = db.users.find(item => item.ph === mobile);
    if (user) {
      const otp = String(crypto.randomInt(100000, 1000000));
      const hash = await bcrypt.hash(otp, 10);
      await sendOtp(user.em, otp);
      otpChallenges.set(mobile, { userId: user.id, hash, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
    }
    return send(res, 200, { message: 'If an account exists, a password-reset OTP has been sent.' });
  }

  if (url === '/api/verify-otp' && req.method === 'POST') {
    const body = await readBody(req);
    const mobile = normalizeMobile(body.mobile);
    const otp = String(body.otp || '').trim();
    if (!MOB.test(mobile)) throw new HttpError(400, 'Enter a 10-digit mobile number');
    if (!limitRequest(`otp-verify-ip:${clientIp(req)}`, 30, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Too many OTP attempts. Please try again later.');
    }
    if (!limitRequest(`otp-verify:${clientIp(req)}:${mobile}`, 10, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Too many OTP attempts. Please try again later.');
    }
    const challenge = otpChallenges.get(mobile);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.attempts >= 5) {
      otpChallenges.delete(mobile);
      throw new HttpError(400, 'Incorrect or expired OTP');
    }
    challenge.attempts += 1;
    if (!await bcrypt.compare(otp, challenge.hash)) {
      if (challenge.attempts >= 5) otpChallenges.delete(mobile);
      throw new HttpError(400, 'Incorrect or expired OTP');
    }
    otpChallenges.delete(mobile);
    const resetToken = randomToken();
    resetChallenges.set(resetToken, { userId: challenge.userId, mobile, expiresAt: Date.now() + 10 * 60 * 1000 });
    return send(res, 200, { resetToken });
  }

  if (url === '/api/reset-password' && req.method === 'POST') {
    const body = await readBody(req);
    const mobile = normalizeMobile(body.mobile);
    const password = String(body.password || '');
    const challenge = resetChallenges.get(String(body.resetToken || ''));
    if (!MOB.test(mobile)) throw new HttpError(400, 'Enter a 10-digit mobile number');
    if (!PW.test(password)) throw new HttpError(400, 'Password needs 8+ characters with letters and numbers');
    if (!challenge || challenge.mobile !== mobile || challenge.expiresAt < Date.now()) {
      throw new HttpError(400, 'Password reset session expired. Request a new OTP.');
    }
    const user = db.users.find(item => item.id === challenge.userId && item.ph === mobile);
    if (!user) throw new HttpError(400, 'Password reset session expired. Request a new OTP.');
    user.pw = await passwordHash(password);
    for (const [token, userId] of Object.entries(db.sessions)) {
      if (userId === user.id) delete db.sessions[token];
    }
    resetChallenges.delete(String(body.resetToken));
    await save();
    return send(res, 200, { message: 'Password reset successfully' });
  }

  return send(res, 404, { error: 'Not found' });
}

const FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/script.js': 'script.js'
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

async function start() {
  await initializeStorage();
  await seedAdmin();
  http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
      if (url.startsWith('/api/')) return await api(req, res, url);
      const file = FILES[url];
      if (!file) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
      fs.createReadStream(path.join(__dirname, file)).pipe(res);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (!(error instanceof HttpError)) console.error(error);
      send(res, error.status || 500, {
        error: error instanceof HttpError ? error.message : 'Internal server error'
      });
    }
  }).listen(PORT, () => {
    console.log(`JobConnect running at http://localhost:${PORT}`);
    console.log(USE_POSTGRES ? 'Using PostgreSQL storage' : 'Using local JSON file storage');
  });
}

start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
