import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
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

// Redis connection (optional; gracefully fallback to in-memory if not configured)
let redis: Redis | null = null;
try {
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    redis.on('error', () => { /* ignore errors, fallback will be used */ });
  }
} catch { redis = null; }

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
    if (!redis) throw new Error('no redis');
    const countStr = await redis.get(KEY_COUNT);
    const count = Number(countStr || '0');
    return { count, remaining: Math.max(0, CAP - count) };
  } catch {
    return { count: memStore.count, remaining: Math.max(0, CAP - memStore.count) };
  }
}

async function incrementCount(): Promise<number> {
  try {
    if (!redis) throw new Error('no redis');
    const v = await redis.incr(KEY_COUNT);
    return v;
  } catch {
    memStore.count += 1;
    return memStore.count;
  }
}

async function hasDuplicate(email: string, username: string): Promise<boolean> {
  try {
    if (!redis) throw new Error('no redis');
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
    if (!redis) throw new Error('no redis');
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
  const hasCreds = !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_PLAY_PACKAGE_NAME);
  if (!hasCreds) {
    return { success: true, skipped: true, reason: 'Missing Google Play credentials' } as const;
  }

  const track = (process.env.GOOGLE_PLAY_TEST_TRACK || 'internal').toLowerCase();

  // Prepare JWT auth
  const privateKey = (env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const jwt = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  const androidpublisher = google.androidpublisher({ version: 'v3', auth: jwt });

  // 1) Create edit
  const insert = await androidpublisher.edits.insert({ packageName: env.GOOGLE_PLAY_PACKAGE_NAME! });
  const editId = insert.data.id!;

  // 2) Get current testers list for the chosen track
  const current = await androidpublisher.edits.testers.get({
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME!,
    editId,
    track,
  });
  const existing = current.data.googleGroups || [];

  const groupEnv = (process.env.GOOGLE_PLAY_TESTER_GROUPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...(existing || []), ...groupEnv]));

  // 4) Update testers
  await androidpublisher.edits.testers.update({
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME!,
    editId,
    track,
    requestBody: {
      googleGroups: merged,
    },
  });

  // 5) Commit edit
  await androidpublisher.edits.commit({ packageName: env.GOOGLE_PLAY_PACKAGE_NAME!, editId });

  return { success: true, track } as const;
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

    // Increment after successful Play add (or stubbed success)
    const newCount = await incrementCount();
    await addApplicant(email, username);

    const adminSubj = 'New App Testing Application';
    const adminBody = `
      <div style="font-family: Arial, sans-serif;">
        <h2>New App Testing Applicant</h2>
        <p><strong>Full Name:</strong> ${fullName}</p>
        <p><strong>Username:</strong> ${username}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Country/Region:</strong> ${country}</p>
        ${contact ? `<p><strong>Contact:</strong> ${contact}</p>` : ''}
        <hr />
        <p>Please manually add this email to the Play testing list and share the download link via WhatsApp.</p>
      </div>
    `;
    await sendEmail('suradkaradarsh@gmail.com', adminSubj, adminBody);

    res.json({
      success: true,
      remaining: Math.max(0, CAP - newCount),
      message: 'Your application is in process. Please wait up to 24 hours to receive the download link via WhatsApp.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Internal server error' });
  }
});

router.get('/app-testing/remaining', async (_req: Request, res: Response) => {
  const { remaining } = await getCounts();
  res.json({ remaining });
});

export default router;
