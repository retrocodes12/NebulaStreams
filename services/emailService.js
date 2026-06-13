import nodemailer from 'nodemailer';

const escapeText = (value) => String(value ?? '').trim();
const escapeHtml = (value) =>
  escapeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export class EmailService {
  constructor({ config, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.transport = null;
  }

  isConfigured() {
    return Boolean(this.config?.SMTP_HOST && this.config?.SMTP_FROM);
  }

  getTransport() {
    if (!this.isConfigured()) {
      return null;
    }
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: this.config.SMTP_HOST,
        port: this.config.SMTP_PORT,
        secure: this.config.SMTP_SECURE,
        auth: this.config.SMTP_USER || this.config.SMTP_PASS
          ? {
            user: this.config.SMTP_USER,
            pass: this.config.SMTP_PASS
          }
          : undefined,
        pool: true,
        maxConnections: 2,
        maxMessages: 50,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000
      });
    }
    return this.transport;
  }

  async sendSupporterCode({ to, name = '', code, expiresAt, baseUrl }) {
    const transport = this.getTransport();
    if (!transport) {
      throw new Error('Supporter email SMTP is not configured');
    }

    const displayName = escapeText(name) || 'supporter';
    const installUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/configure`;
    const expiryLabel = expiresAt || 'Lifetime';
    const subject = 'Your NebulaStreams supporter code';
    const text = [
      `Hi ${displayName},`,
      '',
      'Thanks for supporting NebulaStreams.',
      '',
      `Supporter code: ${code}`,
      `Valid until: ${expiryLabel}`,
      '',
      `Open config: ${installUrl}`,
      'Paste the code in the Supporter Code field, then install/update the addon.',
      '',
      'Free users keep the same streams. This code only unlocks supporter perks.'
    ].join('\n');
    const html = `
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Thanks for supporting NebulaStreams.</p>
      <p><strong>Supporter code:</strong> <code>${escapeHtml(code)}</code></p>
      <p><strong>Valid until:</strong> ${escapeHtml(expiryLabel)}</p>
      <p><a href="${escapeHtml(installUrl)}">Open NebulaStreams config</a></p>
      <p>Paste the code in the Supporter Code field, then install/update the addon.</p>
      <p>Free users keep the same streams. This code only unlocks supporter perks.</p>
    `;

    await transport.sendMail({
      from: this.config.SMTP_FROM,
      to,
      replyTo: this.config.SUPPORTER_EMAIL_REPLY_TO || undefined,
      subject,
      text,
      html
    });
  }

  async sendSportsToken({ to, name = '', code, expiresAt, baseUrl }) {
    const transport = this.getTransport();
    if (!transport) {
      throw new Error('Sports email SMTP is not configured');
    }

    const displayName = escapeText(name) || 'supporter';
    const installUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/sports`;
    const expiryLabel = expiresAt || 'Lifetime';
    const subject = 'Your Nebula Sports access token';
    const text = [
      `Hi ${displayName},`,
      '',
      'Thanks for supporting Nebula Sports.',
      '',
      `Secret token: ${code}`,
      `Valid until: ${expiryLabel}`,
      '',
      `Open Nebula Sports: ${installUrl}`,
      'Create a username and password, then paste this token on signup.',
      '',
      'Keep this token private. It can be claimed once.'
    ].join('\n');
    const html = `
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Thanks for supporting Nebula Sports.</p>
      <p><strong>Secret token:</strong> <code>${escapeHtml(code)}</code></p>
      <p><strong>Valid until:</strong> ${escapeHtml(expiryLabel)}</p>
      <p><a href="${escapeHtml(installUrl)}">Open Nebula Sports</a></p>
      <p>Create a username and password, then paste this token on signup.</p>
      <p>Keep this token private. It can be claimed once.</p>
    `;

    await transport.sendMail({
      from: this.config.SMTP_FROM,
      to,
      replyTo: this.config.SUPPORTER_EMAIL_REPLY_TO || undefined,
      subject,
      text,
      html
    });
  }

  async sendSportsTrialToken({ to, code, expiresAt, baseUrl }) {
    const transport = this.getTransport();
    if (!transport) {
      throw new Error('Sports email SMTP is not configured');
    }

    const installUrl = `${String(baseUrl || '').replace(/\/+$/u, '') || 'https://nebula.work.gd'}/sports`;
    const expiryLabel = expiresAt || '30 minutes';
    const subject = 'Your Nebula Sports 24h trial token';
    const text = [
      'Nebula Sports 24h trial',
      '',
      `Trial token: ${code}`,
      `Claim before: ${expiryLabel}`,
      '',
      `Open Nebula Sports: ${installUrl}`,
      'Create a username and password, then paste this token on signup.',
      '',
      'The trial starts after signup and lasts 24 hours. This token can be claimed once.'
    ].join('\n');
    const html = `
      <p><strong>Nebula Sports 24h trial</strong></p>
      <p><strong>Trial token:</strong> <code>${escapeHtml(code)}</code></p>
      <p><strong>Claim before:</strong> ${escapeHtml(expiryLabel)}</p>
      <p><a href="${escapeHtml(installUrl)}">Open Nebula Sports</a></p>
      <p>Create a username and password, then paste this token on signup.</p>
      <p>The trial starts after signup and lasts 24 hours. This token can be claimed once.</p>
    `;

    await transport.sendMail({
      from: this.config.SMTP_FROM,
      to,
      replyTo: this.config.SUPPORTER_EMAIL_REPLY_TO || undefined,
      subject,
      text,
      html
    });
  }
}
