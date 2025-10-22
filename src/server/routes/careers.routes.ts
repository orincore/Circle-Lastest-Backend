import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import Redis from 'ioredis';
import { env } from '../config/env.js';

const router = Router();

// Rate limit to avoid abuse: 20 requests/hour per IP
const applyRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Redis connection (optional; gracefully fallback to in-memory if fails)
const redis = new Redis(process.env.REDIS_URL || undefined);
redis.on('error', () => {/* ignore errors, fallback will be used */});

// In-memory fallback if Redis unavailable (non-persistent)
const memStore = {
  emails: new Set<string>(),
  usernames: new Set<string>(),
  count: 0,
};

const CAP = 50;
const REDIS_PREFIX = 'careers:app-testing';
const KEY_EMAILS = `${REDIS_PREFIX}:emails`;
const KEY_USERNAMES = `${REDIS_PREFIX}:usernames`;
const KEY_COUNT = `${REDIS_PREFIX}:count`;

function validatePayload(body: any): string[] {
  const errors: string[] = [];
  const { username, email, fullName, country, role } = body || {};
  if (role !== 'app-testing') errors.push('Invalid role');
  if (!username || typeof username !== 'string' || username.trim().length < 3) errors.push('Valid username is required');
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Valid email is required');
  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) errors.push('Full name is required');
  if (!country || typeof country !== 'string' || country.trim().length < 2) errors.push('Country/Region is required');
  return errors;
}

async function getCounts(): Promise<{ count: number; remaining: number; }> {
  try {
    const countStr = await redis.get(KEY_COUNT);
    const count = Number(countStr || '0');
    return { count, remaining: Math.max(0, CAP - count) };
  } catch {
    return { count: memStore.count, remaining: Math.max(0, CAP - memStore.count) };
  }
}

async function incrementCount(): Promise<number> {
  try {
    const v = await redis.incr(KEY_COUNT);
    return v;
  } catch {
    memStore.count += 1;
    return memStore.count;
  }
}

async function hasDuplicate(email: string, username: string): Promise<boolean> {
  try {
    const [e, u] = await Promise.all([
      redis.sismember(KEY_EMAILS, email.toLowerCase()),
      redis.sismember(KEY_USERNAMES, username.toLowerCase()),
    ]);
    return (e === 1) || (u === 1);
  } catch {
    return memStore.emails.has(email.toLowerCase()) || memStore.usernames.has(username.toLowerCase());
  }
}

async function addApplicant(email: string, username: string): Promise<void> {
  try {
    await Promise.all([
      redis.sadd(KEY_EMAILS, email.toLowerCase()),
      redis.sadd(KEY_USERNAMES, username.toLowerCase()),
    ]);
  } catch {
    memStore.emails.add(email.toLowerCase());
    memStore.usernames.add(username.toLowerCase());
  }
}

async function addGooglePlayTester(email: string) {
  // Stub for Google Play Developer API integration
  // Implement with googleapis (AndroidPublisher) using service account creds in env
  const hasCreds = !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_PLAY_PACKAGE_NAME);
  if (!hasCreds) {
    return { success: true, skipped: true };
  }
  // TODO: Implement Android Publisher API call to add tester email to appropriate track/list
  return { success: true, skipped: true };
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
    return { success: true, skipped: true };
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const from = env.SMTP_FROM || 'Circle <no-reply@circle.app>';
  await transporter.sendMail({ from, to, subject, html });
  return { success: true };
}

router.post('/app-testing/apply', applyRateLimit, async (req: Request, res: Response) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const { username, email, fullName, country, contact } = req.body as { username: string; email: string; fullName: string; country: string; contact?: string };

    // Capacity check
    const { count, remaining } = await getCounts();
    if (count >= CAP) {
      return res.status(409).json({ error: 'Applications are closed. Please try again later.', remaining: 0 });
    }

    // Duplicate check
    if (await hasDuplicate(email, username)) {
      return res.status(409).json({ error: 'You have already applied with this email/username.' });
    }

    // Add to tester list (stubbed unless creds provided)
    const gp = await addGooglePlayTester(email);

    // Increment after successful Play add (or stubbed success)
    const newCount = await incrementCount();
    await addApplicant(email, username);

    // Send email with download instructions
    const pkg = env.GOOGLE_PLAY_PACKAGE_NAME || 'your.package.name';
    const testingLink = process.env.TESTING_DOWNLOAD_URL || `https://play.google.com/store/apps/details?id=${pkg}`;
    const subj = 'Circle App Testing — Access Instructions';
    const body = `
      <div style="font-family: Arial, sans-serif;">
        <h2>Welcome to Circle App Testing</h2>
        <p>Hi ${fullName},</p>
        <p>You're approved for the App Testing role. This role lasts a maximum of <strong>60 days</strong>. Please:</p>
        <ul>
          <li>Use Circle at least <strong>30 minutes daily</strong>.</li>
          <li>Report any issues via any medium (in-app support, email, etc.).</li>
          <li>Install using the <strong>same email</strong> you used to apply.</li>
        </ul>
        <p><a href="${testingLink}" target="_blank">Download / Install from Google Play</a></p>
        <p>Note: If the link does not open for you immediately, please ensure your email is part of the testing program and try again in a little while.</p>
        <hr />
        <p>Thanks,<br/>Circle Team</p>
      </div>
    `;
    await sendEmail(email, subj, body);

    res.json({ success: true, remaining: Math.max(0, CAP - newCount), googlePlay: gp });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Internal server error' });
  }
});

router.get('/app-testing/remaining', async (_req: Request, res: Response) => {
  const { remaining } = await getCounts();
  res.json({ remaining });
});

export default router;
