import { readFile } from 'node:fs/promises';

import { config } from '../config.js';
import { EmailService } from '../services/emailService.js';

const loadDotEnv = async () => {
  try {
    const raw = await readFile('.env', 'utf8');
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/gu, '');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

const parseRecipients = (value = '') => String(value)
  .split(/[\s,;]+/u)
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(entry))
  .filter((entry, index, entries) => entries.indexOf(entry) === index);

const getArgValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
};

const run = async () => {
  await loadDotEnv();
  const recipientFile = getArgValue('--file') || process.env.SPORTS_UPDATE_EMAIL_FILE || '';
  const fromFile = recipientFile ? await readFile(recipientFile, 'utf8') : '';
  const recipients = parseRecipients([
    process.env.SPORTS_UPDATE_EMAILS || '',
    getArgValue('--emails') || '',
    fromFile
  ].join('\n'));
  const dryRun = process.argv.includes('--dry-run');

  if (!recipients.length) {
    throw new Error('No recipients. Set SPORTS_UPDATE_EMAILS, pass --emails, or pass --file.');
  }

  const emailService = new EmailService({ config, logger: console });
  if (!dryRun && !emailService.isConfigured()) {
    throw new Error('Supporter email SMTP is not configured');
  }

  const result = {
    dryRun,
    recipients: recipients.length,
    sent: 0,
    failed: []
  };

  for (const to of recipients) {
    if (dryRun) {
      console.log(JSON.stringify({ dryRun: true, to }));
      continue;
    }
    try {
      await emailService.sendSportsLiveTvUpdate({
        to,
        baseUrl: config.PUBLIC_BASE_URL
      });
      result.sent += 1;
      console.log(JSON.stringify({ sent: true, to }));
      await new Promise((resolve) => setTimeout(resolve, 750));
    } catch (error) {
      result.failed.push({ to, error: error?.message || String(error) });
      console.error(JSON.stringify({ sent: false, to, error: error?.message || String(error) }));
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
