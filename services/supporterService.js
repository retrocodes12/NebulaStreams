import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;

const normalizeLabel = (value) => String(value || '').trim().slice(0, 80);
const normalizeTier = (value) => String(value || 'supporter').trim().toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 32) || 'supporter';
const normalizeStatus = (value) => (String(value || '').trim().toLowerCase() === 'revoked' ? 'revoked' : 'active');
const normalizeCode = (value) => String(value || '').trim().replace(/\s+/gu, '').toUpperCase();
const normalizeEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 254);
const normalizeTransactionId = (value) => String(value || '').trim().slice(0, 120);
const normalizeUsername = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 32);
const normalizeProfileName = (value) => String(value || 'Default').trim().slice(0, 48) || 'Default';
const isLifetimeTier = (tier) => ['founder', 'lifetime', 'nebula-founder'].includes(normalizeTier(tier));

const maskEmail = (email) => {
  const normalized = normalizeEmail(email);
  const [user, domain] = normalized.split('@');
  if (!user || !domain) return '';
  const visibleUser = user.length <= 2 ? `${user.slice(0, 1)}*` : `${user.slice(0, 2)}***`;
  const [domainName, ...suffixParts] = domain.split('.');
  const suffix = suffixParts.join('.');
  const visibleDomain = domainName ? `${domainName.slice(0, 1)}***` : '***';
  return suffix ? `${visibleUser}@${visibleDomain}.${suffix}` : `${visibleUser}@${visibleDomain}`;
};

const addMonths = (date, months) => {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

export class SupporterService {
  constructor({ cacheDir, secret, logger = console } = {}) {
    this.cacheDir = cacheDir || path.resolve(process.cwd(), 'cache');
    this.secret = String(secret || 'nebulastreams-supporters');
    this.logger = logger;
    this.storePath = path.join(this.cacheDir, 'supporters.json');
    this.store = { version: STORE_VERSION, codes: {}, payments: {}, accounts: {}, usernames: {}, sessions: {} };
  }

  async initialize() {
    await mkdir(this.cacheDir, { recursive: true });
    try {
      const payload = JSON.parse(await readFile(this.storePath, 'utf8'));
      this.store = {
        version: STORE_VERSION,
        codes: payload && typeof payload.codes === 'object' && !Array.isArray(payload.codes) ? payload.codes : {},
        payments: payload && typeof payload.payments === 'object' && !Array.isArray(payload.payments) ? payload.payments : {},
        accounts: payload && typeof payload.accounts === 'object' && !Array.isArray(payload.accounts) ? payload.accounts : {},
        usernames: payload && typeof payload.usernames === 'object' && !Array.isArray(payload.usernames) ? payload.usernames : {},
        sessions: payload && typeof payload.sessions === 'object' && !Array.isArray(payload.sessions) ? payload.sessions : {}
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.('supporter store load failed', { error: error?.message || String(error) });
      }
      await this.save();
    }
  }

  hashCode(code) {
    return createHash('sha256')
      .update(`${this.secret}:${normalizeCode(code)}`)
      .digest('hex');
  }

  hashEmail(email) {
    return createHash('sha256')
      .update(`${this.secret}:email:${normalizeEmail(email)}`)
      .digest('hex');
  }

  async save() {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
  }

  async createCode({ label = '', tier = 'supporter', months = 1 } = {}) {
    await this.initialize();
    const code = `NS-${randomBytes(9).toString('base64url').toUpperCase()}`;
    const now = new Date();
    const hash = this.hashCode(code);
    const monthCount = Math.max(1, Math.min(Number.parseInt(months, 10) || 1, 36));
    const normalizedTier = normalizeTier(tier);
    const lifetime = isLifetimeTier(normalizedTier);
    this.store.codes[hash] = {
      label: normalizeLabel(label),
      tier: normalizedTier,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: lifetime ? null : addMonths(now, monthCount).toISOString(),
      lifetime,
      lastUsedAt: null
    };
    await this.save();
    return { code, hash, ...this.store.codes[hash] };
  }

  findAccountIdByEmail(email) {
    const emailHash = normalizeEmail(email) ? this.hashEmail(email) : '';
    if (!emailHash) return null;
    for (const [accountId, account] of Object.entries(this.store.accounts || {})) {
      if (account?.emailHash === emailHash) {
        return accountId;
      }
    }
    return null;
  }

  getOrCreateAccountIdForCodeHash(codeHash, email = '') {
    const normalizedHash = String(codeHash || '').trim().toLowerCase();
    for (const [accountId, account] of Object.entries(this.store.accounts || {})) {
      if (account?.codeHash === normalizedHash) {
        return accountId;
      }
    }
    const emailAccountId = this.findAccountIdByEmail(email);
    if (emailAccountId) {
      return emailAccountId;
    }
    return randomBytes(12).toString('hex');
  }

  getAccountByCodeHash(codeHash) {
    const normalizedHash = String(codeHash || '').trim().toLowerCase();
    if (!normalizedHash) return null;
    for (const account of Object.values(this.store.accounts || {})) {
      if (account?.codeHash === normalizedHash) {
        return account;
      }
    }
    return null;
  }
  async upsertAccountForCode({ codeHash, email = '', label = '', tier = 'supporter', expiresAt = null, lifetime = false } = {}) {
    await this.initialize();
    const normalizedHash = String(codeHash || '').trim().toLowerCase();
    if (!normalizedHash) return null;
    const now = new Date().toISOString();
    const accountId = this.getOrCreateAccountIdForCodeHash(normalizedHash, email);
    const existing = this.store.accounts[accountId] || {};
    const normalizedTier = normalizeTier(tier || existing.tier || 'supporter');
    const nextLifetime = Boolean(lifetime || existing.lifetime || isLifetimeTier(normalizedTier));
    this.store.accounts[accountId] = {
      id: accountId,
      codeHash: normalizedHash,
      emailHash: normalizeEmail(email) ? this.hashEmail(email) : existing.emailHash || null,
      emailMasked: maskEmail(email) || existing.emailMasked || '',
      label: normalizeLabel(label || existing.label || 'Supporter'),
      username: normalizeUsername(existing.username || ''),
      tier: nextLifetime ? 'founder' : normalizedTier,
      status: 'active',
      badges: Array.from(new Set([
        ...(Array.isArray(existing.badges) ? existing.badges : []),
        nextLifetime ? 'Nebula Founder' : 'Nebula Supporter',
        existing.createdAt ? null : 'Early Adopter'
      ].filter(Boolean))),
      theme: existing.theme || 'nebula',
      createdAt: existing.createdAt || now,
      updatedAt: now,
      lastActiveAt: existing.lastActiveAt || null,
      expiresAt: nextLifetime ? null : (expiresAt || existing.expiresAt || null),
      lifetime: nextLifetime,
      stats: {
        installs: Number(existing.stats?.installs || 0),
        manifests: Number(existing.stats?.manifests || 0),
        configsCreated: Number(existing.stats?.configsCreated || 0),
        profileSyncs: Number(existing.stats?.profileSyncs || 0),
        lastSyncAt: existing.stats?.lastSyncAt || null,
        mostUsedProviders: existing.stats?.mostUsedProviders || {}
      },
      profiles: existing.profiles && typeof existing.profiles === 'object' ? existing.profiles : {},
      backups: Array.isArray(existing.backups) ? existing.backups : [],
      defaultProfileId: existing.defaultProfileId || null,
      anonymousWall: Boolean(existing.anonymousWall)
    };
    await this.save();
    return this.getAccount(accountId);
  }

  async updateAccountStatusByEmail(email, status = 'inactive') {
    await this.initialize();
    const accountId = this.findAccountIdByEmail(email);
    if (!accountId) return null;
    const account = this.getAccount(accountId);
    account.status = normalizeStatus(status) === 'revoked' ? 'revoked' : String(status || 'inactive').trim().toLowerCase().slice(0, 32) || 'inactive';
    account.updatedAt = new Date().toISOString();
    await this.save();
    return account;
  }

  hasPayment(transactionId) {
    const normalizedTransactionId = normalizeTransactionId(transactionId);
    return Boolean(normalizedTransactionId && this.store.payments[normalizedTransactionId]);
  }

  async recordPayment({
    transactionId,
    email,
    amount = '',
    currency = '',
    paymentType = '',
    codeHash = '',
    emailSentAt = null
  } = {}) {
    await this.initialize();
    const normalizedTransactionId = normalizeTransactionId(transactionId);
    if (!normalizedTransactionId) {
      return null;
    }

    this.store.payments[normalizedTransactionId] = {
      emailHash: normalizeEmail(email) ? this.hashEmail(email) : null,
      emailMasked: maskEmail(email),
      amount: String(amount || '').slice(0, 32),
      currency: String(currency || '').trim().toUpperCase().slice(0, 8),
      paymentType: String(paymentType || '').trim().slice(0, 64),
      codeHash: String(codeHash || '').trim().toLowerCase(),
      createdAt: new Date().toISOString(),
      emailSentAt
    };
    await this.save();
    return this.store.payments[normalizedTransactionId];
  }

  async revokeCode(hash) {
    await this.initialize();
    const normalizedHash = String(hash || '').trim().toLowerCase();
    if (!this.store.codes[normalizedHash]) {
      return false;
    }
    this.store.codes[normalizedHash].status = 'revoked';
    this.store.codes[normalizedHash].revokedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async validateCode(code, { touch = false } = {}) {
    await this.initialize();
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode) {
      return { configured: false, valid: false, message: 'Not configured' };
    }

    const hash = this.hashCode(normalizedCode);
    let record = this.store.codes[hash];
    if (!record) {
      await this.initialize();
      record = this.store.codes[hash];
    }
    if (!record) {
      return { configured: true, valid: false, message: 'Invalid supporter code' };
    }
    if (normalizeStatus(record.status) !== 'active') {
      return { configured: true, valid: false, message: 'Supporter code revoked' };
    }
    const linkedAccount = this.getAccountByCodeHash(hash);
    if (linkedAccount && linkedAccount.status !== 'active') {
      return { configured: true, valid: false, message: 'Supporter account inactive' };
    }
    const lifetime = Boolean(record.lifetime || isLifetimeTier(record.tier));
    const expiresAt = lifetime ? Number.POSITIVE_INFINITY : Date.parse(record.expiresAt || '');
    if (!lifetime && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return { configured: true, valid: false, message: 'Supporter code expired' };
    }

    if (touch) {
      record.lastUsedAt = new Date().toISOString();
      await this.save();
    }

    return {
      configured: true,
      valid: true,
      message: 'Valid',
      supporter: {
        active: true,
        tier: normalizeTier(record.tier),
        label: normalizeLabel(record.label),
        expiresAt: lifetime ? null : new Date(expiresAt).toISOString(),
        lifetime,
        codeHash: hash
      }
    };
  }

  async authenticateCode(code) {
    const validation = await this.validateCode(code, { touch: true });
    if (!validation.valid) return validation;
    const account = await this.upsertAccountForCode({
      codeHash: validation.supporter.codeHash,
      label: validation.supporter.label,
      tier: validation.supporter.tier,
      expiresAt: validation.supporter.expiresAt,
      lifetime: validation.supporter.lifetime
    });
    return { ...validation, account };
  }

  hashSessionToken(token) {
    return createHash('sha256')
      .update(`${this.secret}:session:${String(token || '')}`)
      .digest('hex');
  }

  async createSession(accountId) {
    await this.initialize();
    const token = `ns_sess_${randomBytes(24).toString('base64url')}`;
    const tokenHash = this.hashSessionToken(token);
    this.store.sessions[tokenHash] = {
      accountId,
      createdAt: new Date().toISOString(),
      expiresAt: addMonths(new Date(), 3).toISOString(),
      lastUsedAt: null
    };
    await this.save();
    return token;
  }

  async validateSession(token) {
    await this.initialize();
    const tokenHash = this.hashSessionToken(token);
    let session = this.store.sessions[tokenHash];
    if (!session) {
      await this.initialize();
      session = this.store.sessions[tokenHash];
    }
    if (!session) return null;
    if (Date.parse(session.expiresAt || '') <= Date.now()) {
      delete this.store.sessions[tokenHash];
      await this.save();
      return null;
    }
    const account = this.getAccount(session.accountId);
    if (!account || account.status !== 'active') return null;
    session.lastUsedAt = new Date().toISOString();
    account.lastActiveAt = session.lastUsedAt;
    await this.save();
    return account;
  }

  async destroySession(token) {
    await this.initialize();
    const tokenHash = this.hashSessionToken(token);
    if (this.store.sessions[tokenHash]) {
      delete this.store.sessions[tokenHash];
      await this.save();
    }
  }

  getAccount(accountId) {
    const account = this.store.accounts?.[String(accountId || '')] || null;
    if (!account) return null;
    return account;
  }

  getAccountByUsername(username) {
    const normalized = normalizeUsername(username);
    const accountId = this.store.usernames?.[normalized];
    return accountId ? this.getAccount(accountId) : null;
  }

  async updateAccountSettings(accountId, { username, theme, label, anonymousWall } = {}) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return null;
    const nextUsername = normalizeUsername(username);
    if (nextUsername) {
      if (nextUsername.length < 3) {
        throw new Error('Username must be at least 3 characters');
      }
      const owner = this.store.usernames[nextUsername];
      if (owner && owner !== accountId) {
        throw new Error('Username already taken');
      }
      if (account.username && this.store.usernames[account.username] === accountId) {
        delete this.store.usernames[account.username];
      }
      account.username = nextUsername;
      this.store.usernames[nextUsername] = accountId;
    }
    if (theme) {
      const allowedThemes = new Set(['nebula', 'nebula-purple', 'amoled-black', 'cyber-green', 'aurora', 'synthwave']);
      account.theme = allowedThemes.has(theme) ? theme : 'nebula';
    }
    if (label !== undefined) {
      account.label = normalizeLabel(label);
    }
    if (anonymousWall !== undefined) {
      account.anonymousWall = Boolean(anonymousWall);
    }
    account.updatedAt = new Date().toISOString();
    await this.save();
    return account;
  }

  async saveProfile(accountId, { name = 'Default', configJson = {}, makeDefault = true } = {}) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return null;
    const id = randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    account.profiles[id] = {
      id,
      name: normalizeProfileName(name),
      configJson,
      createdAt: now,
      updatedAt: now
    };
    if (makeDefault || !account.defaultProfileId) {
      account.defaultProfileId = id;
    }
    account.stats.configsCreated = Number(account.stats.configsCreated || 0) + 1;
    account.stats.profileSyncs = Number(account.stats.profileSyncs || 0) + 1;
    account.stats.lastSyncAt = now;
    account.updatedAt = now;
    await this.save();
    return account.profiles[id];
  }

  async deleteProfile(accountId, profileId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account?.profiles?.[profileId]) return false;
    delete account.profiles[profileId];
    if (account.defaultProfileId === profileId) {
      account.defaultProfileId = Object.keys(account.profiles)[0] || null;
    }
    account.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async renameProfile(accountId, profileId, name) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account?.profiles?.[profileId]) return null;
    account.profiles[profileId].name = normalizeProfileName(name);
    account.profiles[profileId].updatedAt = new Date().toISOString();
    account.updatedAt = account.profiles[profileId].updatedAt;
    await this.save();
    return account.profiles[profileId];
  }

  async setDefaultProfile(accountId, profileId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account?.profiles?.[profileId]) return false;
    account.defaultProfileId = profileId;
    account.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async createBackup(accountId, { name = '', configJson = {} } = {}) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return null;
    const backup = {
      id: randomBytes(8).toString('hex'),
      name: normalizeProfileName(name || `Backup ${new Date().toISOString().slice(0, 10)}`),
      configJson,
      createdAt: new Date().toISOString()
    };
    account.backups.unshift(backup);
    account.backups = account.backups.slice(0, 25);
    account.updatedAt = backup.createdAt;
    await this.save();
    return backup;
  }

  async restoreBackup(accountId, backupId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    const backup = account?.backups?.find((entry) => entry.id === backupId);
    if (!account || !backup) return null;
    return this.saveProfile(accountId, {
      name: `Restored ${backup.name}`,
      configJson: backup.configJson || {},
      makeDefault: true
    });
  }

  async getBackup(accountId, backupId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    return account?.backups?.find((entry) => entry.id === backupId) || null;
  }

  async deleteBackup(accountId, backupId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account?.backups) return false;
    const before = account.backups.length;
    account.backups = account.backups.filter((entry) => entry.id !== backupId);
    if (account.backups.length === before) return false;
    account.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async deleteAccount(accountId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return false;
    if (account.username && this.store.usernames?.[account.username] === accountId) {
      delete this.store.usernames[account.username];
    }
    for (const [hash, session] of Object.entries(this.store.sessions || {})) {
      if (session?.accountId === accountId) {
        delete this.store.sessions[hash];
      }
    }
    delete this.store.accounts[accountId];
    await this.save();
    return true;
  }

  async incrementAccountStat(accountId, key, amount = 1) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return;
    account.stats = account.stats || {};
    account.stats[key] = Number(account.stats[key] || 0) + amount;
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    account.stats.daily = account.stats.daily && typeof account.stats.daily === 'object' ? account.stats.daily : {};
    account.stats.daily[dayKey] = account.stats.daily[dayKey] && typeof account.stats.daily[dayKey] === 'object' ? account.stats.daily[dayKey] : {};
    account.stats.daily[dayKey][key] = Number(account.stats.daily[dayKey][key] || 0) + amount;
    const retainedDays = Object.keys(account.stats.daily).sort().slice(-45);
    account.stats.daily = Object.fromEntries(retainedDays.map((day) => [day, account.stats.daily[day]]));
    account.lastActiveAt = now.toISOString();
    await this.save();
  }

  getWall() {
    return Object.values(this.store.accounts || {})
      .filter((account) => account.status === 'active' && !account.anonymousWall)
      .map((account) => ({
        label: account.username || account.label || 'Supporter',
        tier: account.tier || 'supporter',
        badges: Array.isArray(account.badges) ? account.badges : [],
        createdAt: account.createdAt || null,
        lifetime: Boolean(account.lifetime)
      }))
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  }

  listCodes() {
    return Object.entries(this.store.codes)
      .map(([hash, record]) => ({
        hash,
        hashPrefix: hash.slice(0, 10),
        label: normalizeLabel(record.label),
        tier: normalizeTier(record.tier),
        status: normalizeStatus(record.status),
        createdAt: record.createdAt || null,
        expiresAt: record.expiresAt || null,
        lastUsedAt: record.lastUsedAt || null,
        expired: Number.isFinite(Date.parse(record.expiresAt || '')) && Date.parse(record.expiresAt) <= Date.now()
      }))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  }

  getStats() {
    const codes = this.listCodes();
    const payments = Object.values(this.store.payments || {});
    return {
      total: codes.length,
      active: codes.filter((code) => code.status === 'active' && !code.expired).length,
      expired: codes.filter((code) => code.expired).length,
      revoked: codes.filter((code) => code.status === 'revoked').length,
      payments: payments.length,
      paymentEmailsSent: payments.filter((payment) => payment.emailSentAt).length,
      accounts: Object.keys(this.store.accounts || {}).length,
      founders: Object.values(this.store.accounts || {}).filter((account) => account.lifetime || account.tier === 'founder').length,
      codes
    };
  }
}

export { maskEmail, normalizeUsername };
