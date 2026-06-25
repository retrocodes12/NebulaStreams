import nodemailer from 'nodemailer';

const escapeText = (value) => String(value ?? '').trim();
const escapeHtml = (value) =>
  escapeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const SMTP_ACCOUNT_COUNT = 4;
const SMTP_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SMTP_ERROR_COOLDOWN_MS = 5 * 60 * 1000;

export class EmailService {
  constructor({ config, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.transports = new Map();
    this.accountBlockedUntil = new Map();
    this.nextAccountIndex = 0;
  }

  isConfigured() {
    return this.getAccounts().length > 0;
  }

  getAccounts() {
    const accounts = [];
    for (let index = 1; index <= SMTP_ACCOUNT_COUNT; index += 1) {
      const suffix = index === 1 ? '' : `_${index}`;
      const user = escapeText(this.config?.[`SMTP_USER${suffix}`]);
      const pass = escapeText(this.config?.[`SMTP_PASS${suffix}`]);
      const from = escapeText(this.config?.[`SMTP_FROM${suffix}`]) || (user ? `NebulaStreams <${user}>` : '');
      if (!this.config?.SMTP_HOST || !user || !pass || !from) continue;
      accounts.push({
        id: `smtp-${index}`,
        host: this.config.SMTP_HOST,
        port: this.config.SMTP_PORT,
        secure: this.config.SMTP_SECURE,
        user,
        pass,
        from
      });
    }
    return accounts;
  }

  getTransport(account) {
    if (!account) return null;
    if (!this.transports.has(account.id)) {
      this.transports.set(account.id, nodemailer.createTransport({
        host: account.host,
        port: account.port,
        secure: account.secure,
        auth: account.user || account.pass
          ? {
            user: account.user,
            pass: account.pass
          }
          : undefined,
        pool: true,
        maxConnections: 2,
        maxMessages: 50,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000
      }));
    }
    return this.transports.get(account.id);
  }

  isQuotaError(error) {
    const message = `${error?.responseCode || ''} ${error?.response || ''} ${error?.message || ''}`;
    return /\b(?:4\.2\.2|4\.5\.3|4\.7\.0|5\.4\.5)\b|daily user sending limit|sending quota|rate limit/iu.test(message);
  }

  async sendMail(message) {
    const accounts = this.getAccounts();
    if (!accounts.length) {
      throw new Error('Supporter email SMTP is not configured');
    }

    const now = Date.now();
    const startIndex = this.nextAccountIndex % accounts.length;
    this.nextAccountIndex = (this.nextAccountIndex + 1) % accounts.length;
    let lastError = null;

    for (let offset = 0; offset < accounts.length; offset += 1) {
      const account = accounts[(startIndex + offset) % accounts.length];
      if ((this.accountBlockedUntil.get(account.id) || 0) > now) continue;
      try {
        const result = await this.getTransport(account).sendMail({
          ...message,
          from: account.from,
          replyTo: this.config.SUPPORTER_EMAIL_REPLY_TO || undefined
        });
        this.accountBlockedUntil.delete(account.id);
        this.logger.info?.('supporter email accepted by smtp', {
          sender: account.id,
          acceptedCount: Array.isArray(result?.accepted) ? result.accepted.length : 0,
          rejectedCount: Array.isArray(result?.rejected) ? result.rejected.length : 0,
          response: escapeText(result?.response).slice(0, 160)
        });
        return result;
      } catch (error) {
        lastError = error;
        const quotaError = this.isQuotaError(error);
        this.accountBlockedUntil.set(
          account.id,
          Date.now() + (quotaError ? SMTP_QUOTA_COOLDOWN_MS : SMTP_ERROR_COOLDOWN_MS)
        );
        this.logger.warn?.('supporter email sender failed; trying fallback', {
          sender: account.id,
          quotaError,
          responseCode: error?.responseCode || null
        });
      }
    }

    throw lastError || new Error('All supporter email senders are cooling down');
  }

  async sendSupporterCode({ to, name = '', code, expiresAt, baseUrl }) {
    const displayName = escapeText(name) || 'supporter';
    const installUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/configure`;
    const expiryLabel = expiresAt || 'Lifetime';
    const subject = 'NebulaStreams supporter setup';
    const text = [
      `Hi ${displayName},`,
      '',
      'Thanks for your NebulaStreams support.',
      'This email is your setup receipt for the supporter features you requested.',
      '',
      `Setup code: ${code}`,
      `Access valid until: ${expiryLabel}`,
      '',
      `Setup page: ${installUrl}`,
      'Open the setup page, enter the setup code, then install or update the addon.',
      '',
      'If you did not request this email, ignore it.'
    ].join('\n');
    const html = `
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Thanks for your NebulaStreams support.</p>
      <p>This email is your setup receipt for the supporter features you requested.</p>
      <p><strong>Setup code:</strong> <code>${escapeHtml(code)}</code></p>
      <p><strong>Access valid until:</strong> ${escapeHtml(expiryLabel)}</p>
      <p><a href="${escapeHtml(installUrl)}">Open NebulaStreams setup</a></p>
      <p>Open the setup page, enter the setup code, then install or update the addon.</p>
      <p>If you did not request this email, ignore it.</p>
    `;

    return this.sendMail({
      to,
      subject,
      text,
      html
    });
  }

  async sendSportsToken({ to, name = '', code, expiresAt, baseUrl, tier = '' }) {
    const displayName = escapeText(name) || 'supporter';
    const installUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/sports`;
    const expiryLabel = expiresAt || 'Lifetime';
    const premiumFuture = String(tier || '').trim().toLowerCase() === 'premium-future';
    const subject = 'Nebula Sports supporter setup';
    const text = [
      `Hi ${displayName},`,
      '',
      'Thanks for your Nebula Sports support.',
      'This email confirms your supporter access and gives you the setup code for your private addon account.',
      '',
      `Setup code: ${code}`,
      `Access valid until: ${expiryLabel}`,
      '',
      `Nebula Sports page: ${installUrl}`,
      'Open the page, create your account, and enter the setup code when asked.',
      ...(premiumFuture ? ['', 'Premium Future Support includes premium access to future Nebula addons and projects.'] : []),
      '',
      'If you did not request this email, ignore it.'
    ].join('\n');
    const html = `
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Thanks for your Nebula Sports support.</p>
      <p>This email confirms your supporter access and gives you the setup code for your private addon account.</p>
      <p><strong>Setup code:</strong> <code>${escapeHtml(code)}</code></p>
      <p><strong>Access valid until:</strong> ${escapeHtml(expiryLabel)}</p>
      <p><a href="${escapeHtml(installUrl)}">Open Nebula Sports</a></p>
      <p>Open the page, create your account, and enter the setup code when asked.</p>
      ${premiumFuture ? '<p><strong>Premium Future Support:</strong> Includes premium access to future Nebula addons and projects.</p>' : ''}
      <p>If you did not request this email, ignore it.</p>
    `;

    return this.sendMail({
      to,
      subject,
      text,
      html
    });
  }

  async sendSportsTrialToken({ to, code, expiresAt, baseUrl }) {
    const expiryLabel = expiresAt || '30 minutes';
    const subject = 'Nebula Sports trial setup';
    const text = [
      'Nebula Sports trial setup',
      '',
      'You requested a 24-hour Nebula Sports trial.',
      '',
      `Setup code: ${code}`,
      `Use before: ${expiryLabel}`,
      '',
      'Return to the Nebula Sports page and enter the setup code.',
      '',
      'If you did not request this email, ignore it.'
    ].join('\n');

    return this.sendMail({
      to,
      subject,
      text
    });
  }

  async sendSportsConfigUpdate({ to, baseUrl }) {
    const configureUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/sports/configure`;
    const subject = 'New Nebula Sports supporter configuration';
    const text = [
      'Nebula Sports supporter update',
      '',
      'Your supporter account now includes a private configuration page.',
      '',
      'You can:',
      '- Show live matches only',
      '- Choose which sports appear in Stremio',
      '- Set your local event timezone',
      '- Copy or reinstall your private manifest',
      '',
      `Open configuration: ${configureUrl}`,
      '',
      'Sign in to Nebula Sports first, then open the configuration page.'
    ].join('\n');
    const html = `
      <p><strong>Nebula Sports supporter update</strong></p>
      <p>Your supporter account now includes a private configuration page.</p>
      <ul>
        <li>Show live matches only</li>
        <li>Choose which sports appear in Stremio</li>
        <li>Set your local event timezone</li>
        <li>Copy or reinstall your private manifest</li>
      </ul>
      <p><a href="${escapeHtml(configureUrl)}">Open Nebula Sports configuration</a></p>
      <p>Sign in to Nebula Sports first, then open the configuration page.</p>
    `;

    return this.sendMail({ to, subject, text, html });
  }

  async sendSportsLiveTvUpdate({ to, baseUrl }) {
    const sportsUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/sports`;
    const subject = 'Nebula Sports live TV update';
    const text = [
      'Nebula Sports supporter update',
      '',
      'Live TV catalogs are now available for monthly and lifetime supporters.',
      '',
      'What changed:',
      '- New live TV section inside Stremio',
      '- More sports channels for supporter accounts',
      '- Same private Nebula Sports install link',
      '',
      'Open Nebula Sports:',
      sportsUrl,
      '',
      'If channels do not appear right away, refresh or reinstall your private addon from the Nebula Sports page.',
      '',
      'Thanks for supporting Nebula Sports.'
    ].join('\n');
    const html = `
      <p><strong>Nebula Sports supporter update</strong></p>
      <p>Live TV catalogs are now available for monthly and lifetime supporters.</p>
      <p><strong>What changed:</strong></p>
      <ul>
        <li>New live TV section inside Stremio</li>
        <li>More sports channels for supporter accounts</li>
        <li>Same private Nebula Sports install link</li>
      </ul>
      <p><a href="${escapeHtml(sportsUrl)}">Open Nebula Sports</a></p>
      <p>If channels do not appear right away, refresh or reinstall your private addon from the Nebula Sports page.</p>
      <p>Thanks for supporting Nebula Sports.</p>
    `;

    return this.sendMail({ to, subject, text, html });
  }
}
