import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
const STORE_VERSION = 1;

const normalizeCode = (value) => String(value || '').trim().replace(/\s+/gu, '').toUpperCase();
const normalizeEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 254);
const normalizeLabel = (value) => String(value || '').trim().slice(0, 80);
const normalizeTier = (value) => String(value || 'monthly').trim().toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 32) || 'monthly';
const normalizeUsername = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 32);
const normalizeTransactionId = (value) => String(value || '').trim().slice(0, 120);
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_CLAIM_TTL_MS = 30 * 60 * 1000;
const TRIAL_ACCESS_HOURS = 24;
const STORE_REFRESH_MS = 30_000;
const STATS_SAVE_DELAY_MS = 5_000;
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  '10minutemail.net',
  'guerrillamail.com',
  'guerrillamail.net',
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'sharklasers.com',
  'throwawaymail.com',
  'trashmail.com'
]);

const addMonths = (date, months) => {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const maskEmail = (email) => {
  const normalized = normalizeEmail(email);
  const [user, domain] = normalized.split('@');
  if (!user || !domain) return '';
  return `${user.slice(0, 2) || '*'}***@${domain.slice(0, 1)}***`;
};

const isLifetimeTier = (tier) => ['lifetime', 'founder', 'sports-lifetime', 'premium-future'].includes(normalizeTier(tier));
const isFreeTier = (tier) => normalizeTier(tier) === 'free';

const normalizeTrialEmail = (value) => {
  const normalized = normalizeEmail(value);
  const [localPart, domain] = normalized.split('@');
  if (!localPart || !domain || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    return '';
  }
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${localPart.split('+', 1)[0].replaceAll('.', '')}@gmail.com`;
  }
  return `${localPart.split('+', 1)[0]}@${domain}`;
};

export class SportsSupporterService {
  constructor({ cacheDir, secret, logger = console } = {}) {
    this.cacheDir = cacheDir || path.resolve(process.cwd(), 'cache');
    this.secret = String(secret || 'nebula-sports');
    this.logger = logger;
    this.storePath = path.join(this.cacheDir, 'sports-supporters.json');
    this.claimLockPath = path.join(this.cacheDir, 'sports-supporters.claim.lock');
    this.store = {
      version: STORE_VERSION,
      tokens: {},
      accounts: {},
      usernames: {},
      installs: {},
      sessions: {},
      payments: {},
      trials: { emails: {}, ipRequests: {}, subnetRequests: {} }
    };
    this.saveChain = Promise.resolve();
    this.initialized = false;
    this.storeLoadedAt = 0;
    this.storeMtimeMs = 0;
    this.statsSaveTimer = null;
  }

  async withClaimLock(task) {
    await mkdir(this.cacheDir, { recursive: true });
    const startedAt = Date.now();
    const timeoutMs = 8_000;
    const staleMs = 15_000;

    for (;;) {
      try {
        await mkdir(this.claimLockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const lockStats = await stat(this.claimLockPath);
          if (Date.now() - lockStats.mtimeMs > staleMs) {
            await rm(this.claimLockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error('Supporter claim is busy. Try again in a few seconds.');
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }

    try {
      await this.initialize({ force: true });
      return await task();
    } finally {
      await rm(this.claimLockPath, { recursive: true, force: true });
    }
  }

  async initialize({ force = false } = {}) {
    await mkdir(this.cacheDir, { recursive: true });
    if (this.initialized && !force && Date.now() - this.storeLoadedAt < STORE_REFRESH_MS) {
      return;
    }
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const stats = await stat(this.storePath).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (this.initialized && stats && stats.mtimeMs <= this.storeMtimeMs && !force) {
          this.storeLoadedAt = Date.now();
          return;
        }
        const payload = stats ? JSON.parse(await readFile(this.storePath, 'utf8')) : null;
        if (!payload) {
          await this.save();
          return;
        }
        this.normalizeStorePayload(payload);
        this.initialized = true;
        this.storeLoadedAt = Date.now();
        this.storeMtimeMs = stats?.mtimeMs || Date.now();
        return;
      } catch (error) {
        if (error?.code === 'ENOENT') {
          await this.save();
          return;
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }

    this.logger.warn?.('sports supporter store load failed', { error: lastError?.message || String(lastError) });
  }

  async save() {
    const runSave = async () => {
      await mkdir(this.cacheDir, { recursive: true });
      let payload = this.store;
      try {
        const current = JSON.parse(await readFile(this.storePath, 'utf8'));
        payload = this.mergeStorePayloadForSave(current, this.store);
        this.store = payload;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger.warn?.('sports supporter store merge failed', { error: error?.message || String(error) });
        }
      }
      const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
      await rename(tempPath, this.storePath);
      this.initialized = true;
      this.storeLoadedAt = Date.now();
      this.storeMtimeMs = Date.now();
    };
    this.saveChain = this.saveChain.then(runSave, runSave);
    return this.saveChain;
  }

  mergeStorePayloadForSave(current = {}, next = {}) {
    const mergeRecords = (left, right) => ({
      ...(left && typeof left === 'object' && !Array.isArray(left) ? left : {}),
      ...(right && typeof right === 'object' && !Array.isArray(right) ? right : {})
    });
    const currentTrials = current && typeof current.trials === 'object' && !Array.isArray(current.trials) ? current.trials : {};
    const nextTrials = next && typeof next.trials === 'object' && !Array.isArray(next.trials) ? next.trials : {};
    return {
      version: STORE_VERSION,
      tokens: mergeRecords(current.tokens, next.tokens),
      accounts: mergeRecords(current.accounts, next.accounts),
      usernames: mergeRecords(current.usernames, next.usernames),
      installs: mergeRecords(current.installs, next.installs),
      sessions: mergeRecords(current.sessions, next.sessions),
      payments: mergeRecords(current.payments, next.payments),
      trials: {
        emails: mergeRecords(currentTrials.emails, nextTrials.emails),
        ipRequests: mergeRecords(currentTrials.ipRequests, nextTrials.ipRequests),
        subnetRequests: mergeRecords(currentTrials.subnetRequests, nextTrials.subnetRequests)
      }
    };
  }

  scheduleStatsSave() {
    if (this.statsSaveTimer) return;
    this.statsSaveTimer = setTimeout(() => {
      this.statsSaveTimer = null;
      this.save().catch((error) => {
        this.logger.warn?.('sports supporter stats save failed', { error: error?.message || String(error) });
      });
    }, STATS_SAVE_DELAY_MS);
    this.statsSaveTimer.unref?.();
  }

  normalizeStorePayload(payload) {
    this.store = {
      version: STORE_VERSION,
      tokens: payload && typeof payload.tokens === 'object' && !Array.isArray(payload.tokens) ? payload.tokens : {},
      accounts: payload && typeof payload.accounts === 'object' && !Array.isArray(payload.accounts) ? payload.accounts : {},
      usernames: payload && typeof payload.usernames === 'object' && !Array.isArray(payload.usernames) ? payload.usernames : {},
      installs: payload && typeof payload.installs === 'object' && !Array.isArray(payload.installs) ? payload.installs : {},
      sessions: payload && typeof payload.sessions === 'object' && !Array.isArray(payload.sessions) ? payload.sessions : {},
      payments: payload && typeof payload.payments === 'object' && !Array.isArray(payload.payments) ? payload.payments : {},
      trials: payload && typeof payload.trials === 'object' && !Array.isArray(payload.trials)
        ? {
          emails: payload.trials.emails && typeof payload.trials.emails === 'object' && !Array.isArray(payload.trials.emails) ? payload.trials.emails : {},
          ipRequests: payload.trials.ipRequests && typeof payload.trials.ipRequests === 'object' && !Array.isArray(payload.trials.ipRequests) ? payload.trials.ipRequests : {},
          subnetRequests: payload.trials.subnetRequests && typeof payload.trials.subnetRequests === 'object' && !Array.isArray(payload.trials.subnetRequests) ? payload.trials.subnetRequests : {}
        }
        : { emails: {}, ipRequests: {}, subnetRequests: {} }
    };
  }

  hashCode(code) {
    return createHash('sha256').update(`${this.secret}:code:${normalizeCode(code)}`).digest('hex');
  }

  hashSessionToken(token) {
    return createHash('sha256').update(`${this.secret}:session:${String(token || '')}`).digest('hex');
  }

  hashIdentity(scope, value) {
    return createHash('sha256').update(`${this.secret}:identity:${scope}:${String(value || '')}`).digest('hex');
  }

  async hashPassword(password, salt = randomBytes(16).toString('base64url')) {
    const passwordHash = await scrypt(String(password || ''), salt, 64);
    return `${salt}:${Buffer.from(passwordHash).toString('base64url')}`;
  }

  async verifyPassword(password, storedHash) {
    const [salt, hash] = String(storedHash || '').split(':', 2);
    if (!salt || !hash) return false;
    const next = await this.hashPassword(password, salt);
    const nextHash = Buffer.from(next.split(':', 2)[1] || '', 'base64url');
    const stored = Buffer.from(hash, 'base64url');
    return nextHash.length === stored.length && timingSafeEqual(nextHash, stored);
  }

  async createToken({ label = '', email = '', tier = 'monthly', months = 1 } = {}) {
    await this.initialize();
    const code = `NSPORT-${randomBytes(9).toString('base64url').toUpperCase()}`;
    const now = new Date();
    const normalizedTier = normalizeTier(tier);
    const lifetime = isLifetimeTier(normalizedTier);
    const freeTier = isFreeTier(normalizedTier);
    const monthCount = Math.max(1, Math.min(Number.parseInt(months, 10) || 1, 36));
    const hash = this.hashCode(code);
    this.store.tokens[hash] = {
      label: normalizeLabel(label),
      emailMasked: maskEmail(email),
      tier: lifetime || freeTier ? normalizedTier : 'monthly',
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: lifetime || freeTier ? null : addMonths(now, monthCount).toISOString(),
      lifetime,
      claimedBy: null,
      claimedAt: null,
      lastUsedAt: null
    };
    await this.save();
    return { code, hash, ...this.store.tokens[hash] };
  }

  pruneTrialRequests(now = Date.now()) {
    this.store.trials = this.store.trials || { emails: {}, ipRequests: {}, subnetRequests: {} };
    for (const bucketName of ['ipRequests', 'subnetRequests']) {
      const bucket = this.store.trials[bucketName] || {};
      for (const [hash, timestamps] of Object.entries(bucket)) {
        const next = (Array.isArray(timestamps) ? timestamps : [])
          .filter((timestamp) => now - Number(timestamp || 0) <= DAY_MS);
        if (next.length) {
          bucket[hash] = next;
        } else {
          delete bucket[hash];
        }
      }
      this.store.trials[bucketName] = bucket;
    }
  }

  isDisposableEmail(email) {
    const domain = normalizeTrialEmail(email).split('@')[1] || '';
    return DISPOSABLE_EMAIL_DOMAINS.has(domain);
  }

  async createTrialToken({ email = '', ip = '', subnet = '' } = {}) {
    await this.initialize();
    const normalizedEmail = normalizeTrialEmail(email);
    const now = Date.now();
    this.pruneTrialRequests(now);

    if (!normalizedEmail || this.isDisposableEmail(normalizedEmail)) {
      await this.save();
      return { created: false, reason: 'ineligible' };
    }

    const emailHash = this.hashIdentity('trial-email', normalizedEmail);
    const ipHash = this.hashIdentity('trial-ip', ip);
    const subnetHash = this.hashIdentity('trial-subnet', subnet || ip);
    const trials = this.store.trials || { emails: {}, ipRequests: {}, subnetRequests: {} };
    const ipRequests = Array.isArray(trials.ipRequests?.[ipHash]) ? trials.ipRequests[ipHash] : [];
    const subnetRequests = Array.isArray(trials.subnetRequests?.[subnetHash]) ? trials.subnetRequests[subnetHash] : [];

    trials.ipRequests[ipHash] = [...ipRequests, now].slice(-10);
    trials.subnetRequests[subnetHash] = [...subnetRequests, now].slice(-20);
    this.store.trials = trials;

    if (trials.emails?.[emailHash] || ipRequests.length >= 2 || subnetRequests.length >= 5) {
      await this.save();
      return { created: false, reason: 'limit' };
    }

    const code = `NSPORT-TRIAL-${randomBytes(9).toString('base64url').toUpperCase()}`;
    const hash = this.hashCode(code);
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + TRIAL_CLAIM_TTL_MS).toISOString();
    this.store.tokens[hash] = {
      label: '24h trial',
      emailMasked: maskEmail(normalizedEmail),
      emailHash,
      ipHash,
      subnetHash,
      tier: 'trial',
      status: 'active',
      createdAt,
      expiresAt,
      lifetime: false,
      accessHours: TRIAL_ACCESS_HOURS,
      claimedBy: null,
      claimedAt: null,
      lastUsedAt: null
    };
    trials.emails[emailHash] = {
      createdAt,
      tokenHash: hash,
      claimedBy: null
    };
    await this.save();
    return { created: true, code, hash, ...this.store.tokens[hash], normalizedEmail };
  }

  async revokeToken(tokenHash, { releaseTrial = false } = {}) {
    await this.initialize();
    const hash = String(tokenHash || '').trim().toLowerCase();
    const token = this.store.tokens[hash];
    if (!token || token.claimedBy) return false;

    token.status = 'revoked';
    token.revokedAt = new Date().toISOString();
    if (releaseTrial && token.tier === 'trial') {
      const trial = this.store.trials || { emails: {}, ipRequests: {}, subnetRequests: {} };
      if (token.emailHash && trial.emails?.[token.emailHash]?.tokenHash === hash) {
        delete trial.emails[token.emailHash];
      }
      const createdAt = Date.parse(token.createdAt || '');
      for (const [bucketName, identityHash] of [
        ['ipRequests', token.ipHash],
        ['subnetRequests', token.subnetHash]
      ]) {
        const requests = Array.isArray(trial[bucketName]?.[identityHash])
          ? trial[bucketName][identityHash]
          : [];
        const next = requests.filter((timestamp) => Number(timestamp) !== createdAt);
        if (next.length) {
          trial[bucketName][identityHash] = next;
        } else if (identityHash) {
          delete trial[bucketName][identityHash];
        }
      }
      this.store.trials = trial;
    }
    await this.save();
    return true;
  }

  validateTokenRecord(tokenHash) {
    const token = this.store.tokens[String(tokenHash || '').trim().toLowerCase()];
    if (!token) return { valid: false, message: 'Invalid sports token' };
    if (token.status !== 'active') return { valid: false, message: 'Sports token inactive' };
    if (token.claimedBy) return { valid: false, message: 'Sports token already claimed' };
    const lifetime = Boolean(token.lifetime);
    const freeTier = isFreeTier(token.tier);
    const expiresAt = lifetime ? Number.POSITIVE_INFINITY : Date.parse(token.expiresAt || '');
    if (!lifetime && !freeTier && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return { valid: false, message: 'Sports token expired' };
    }
    return { valid: true, token };
  }

  getAccount(accountId) {
    return this.store.accounts?.[String(accountId || '')] || null;
  }

  getAccountByUsername(username) {
    const normalized = normalizeUsername(username);
    const accountId = this.store.usernames?.[normalized];
    return accountId ? this.getAccount(accountId) : null;
  }

  getAccountByInstallKey(installKey) {
    const accountId = this.store.installs?.[String(installKey || '').trim()];
    return accountId ? this.getAccount(accountId) : null;
  }

  async getOrCreateFreePreviewAccount() {
    await this.initialize();
    const existing = this.getAccountByUsername('free-preview');
    if (existing && existing.tier === 'free' && this.isAccountActive(existing)) {
      return existing;
    }

    const now = new Date().toISOString();
    const accountId = randomBytes(12).toString('hex');
    const installKey = 'free';
    this.store.accounts[accountId] = {
      id: accountId,
      username: 'free-preview',
      passwordHash: '',
      tokenHash: 'free-preview',
      installKey,
      tier: 'free',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastActiveAt: null,
      expiresAt: null,
      lifetime: false,
      playbackConfigId: null,
      stats: { installs: 0, manifests: 0, catalogs: 0, streams: 0 }
    };
    this.store.usernames['free-preview'] = accountId;
    this.store.installs[installKey] = accountId;
    await this.save();
    return this.getAccount(accountId);
  }

  async claimToken({ username, password, tokenCode }) {
    const tokenHash = this.hashCode(tokenCode);
    return this.claimTokenHash({ username, password, tokenHash });
  }

  async claimTokenHash({ username, password, tokenHash }) {
    return this.withClaimLock(() => this.claimTokenHashUnlocked({ username, password, tokenHash }));
  }

  async claimTokenHashUnlocked({ username, password, tokenHash }) {
    const normalizedUsername = normalizeUsername(username);
    if (normalizedUsername.length < 3) throw new Error('Username must be at least 3 characters');
    if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
    if (this.store.usernames[normalizedUsername]) throw new Error('Username already taken');

    const validation = this.validateTokenRecord(tokenHash);
    if (!validation.valid) throw new Error(validation.message);

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const accountId = randomBytes(12).toString('hex');
    const installKey = `nsports_${randomBytes(18).toString('base64url')}`;
    const tokenTier = normalizeTier(validation.token.tier);
    const isTrial = tokenTier === 'trial';
    const freeTier = isFreeTier(tokenTier);
    const accessHours = Math.max(1, Math.min(Number.parseInt(validation.token.accessHours, 10) || TRIAL_ACCESS_HOURS, 72));
    const accountExpiresAt = validation.token.lifetime || freeTier
      ? null
      : (isTrial ? new Date(nowDate.getTime() + accessHours * 60 * 60 * 1000).toISOString() : validation.token.expiresAt);
    this.store.accounts[accountId] = {
      id: accountId,
      username: normalizedUsername,
      passwordHash: await this.hashPassword(password),
      tokenHash,
      installKey,
      tier: validation.token.lifetime ? tokenTier : (freeTier ? 'free' : (isTrial ? 'trial' : 'monthly')),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastActiveAt: null,
      expiresAt: accountExpiresAt,
      lifetime: Boolean(validation.token.lifetime),
      playbackConfigId: null,
      stats: { installs: 0, manifests: 0, catalogs: 0, streams: 0 }
    };
    this.store.usernames[normalizedUsername] = accountId;
    this.store.installs[installKey] = accountId;
    validation.token.claimedBy = accountId;
    validation.token.claimedAt = now;
    if (validation.token.emailHash && this.store.trials?.emails?.[validation.token.emailHash]) {
      this.store.trials.emails[validation.token.emailHash].claimedBy = accountId;
      this.store.trials.emails[validation.token.emailHash].claimedAt = now;
    }
    await this.save();
    return this.getAccount(accountId);
  }

  getPaymentEmailHash(email) {
    const normalized = normalizeTrialEmail(email) || normalizeEmail(email);
    return normalized ? this.hashIdentity('payment-email', normalized) : '';
  }

  findUnclaimedPayment({ email = '', transactionId = '' } = {}) {
    const normalizedTransactionId = normalizeTransactionId(transactionId);
    const emailHash = this.getPaymentEmailHash(email);
    const entries = Object.entries(this.store.payments || {});
    const matches = normalizedTransactionId
      ? entries.filter(([id]) => id === normalizedTransactionId)
      : entries.filter(([, payment]) => emailHash && payment?.emailHash === emailHash);
    return matches
      .map(([id, payment]) => ({ id, payment }))
      .filter(({ payment }) => payment?.tokenHash && !payment?.claimedBy)
      .find(({ payment }) => payment.emailHash ? (emailHash && payment.emailHash === emailHash) : true)
      || null;
  }

  async claimPayment({ username, password, email = '', transactionId = '' } = {}) {
    return this.withClaimLock(async () => {
      const match = this.findUnclaimedPayment({ email, transactionId });
      if (!match) {
        throw new Error('No unclaimed Ko-fi sports payment found. Use the same email you used on Ko-fi, or paste your Ko-fi order id.');
      }
      const account = await this.claimTokenHashUnlocked({
        username,
        password,
        tokenHash: match.payment.tokenHash
      });
      const payment = this.store.payments?.[match.id];
      if (payment) {
        payment.claimedBy = account.id;
        payment.claimedAt = new Date().toISOString();
        await this.save();
      }
      return account;
    });
  }

  isAccountActive(account) {
    if (!account || account.status !== 'active') return false;
    if (account.lifetime) return true;
    if (isFreeTier(account.tier)) return true;
    const expiresAt = Date.parse(account.expiresAt || '');
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  async authenticate({ username, password }) {
    await this.initialize();
    const account = this.getAccountByUsername(username);
    if (!this.isAccountActive(account)) return { ok: false, message: 'Sports account inactive or expired' };
    if (!await this.verifyPassword(password, account.passwordHash)) {
      return { ok: false, message: 'Invalid username or password' };
    }
    return { ok: true, account };
  }

  async createSession(accountId) {
    await this.initialize();
    const token = `nsports_sess_${randomBytes(24).toString('base64url')}`;
    this.store.sessions[this.hashSessionToken(token)] = {
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
    const hash = this.hashSessionToken(token);
    let session = this.store.sessions[hash];
    if (!session && token) {
      await this.initialize({ force: true });
      session = this.store.sessions[hash];
    }
    if (!session) return null;
    if (Date.parse(session.expiresAt || '') <= Date.now()) {
      delete this.store.sessions[hash];
      await this.save();
      return null;
    }
    const account = this.getAccount(session.accountId);
    if (!this.isAccountActive(account)) return null;
    const now = new Date().toISOString();
    session.lastUsedAt = now;
    account.lastActiveAt = now;
    await this.save();
    return account;
  }

  async destroySession(token) {
    await this.initialize();
    const hash = this.hashSessionToken(token);
    if (this.store.sessions[hash]) {
      delete this.store.sessions[hash];
      await this.save();
    }
  }

  async setPlaybackConfigId(accountId, playbackConfigId) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return null;
    account.playbackConfigId = String(playbackConfigId || '').trim() || null;
    account.updatedAt = new Date().toISOString();
    await this.save();
    return account;
  }

  async updateSportsConfig(accountId, sportsConfig = {}) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return null;
    account.sportsConfig = {
      liveOnly: Boolean(sportsConfig.liveOnly),
      sports: Array.isArray(sportsConfig.sports)
        ? [...new Set(sportsConfig.sports.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 20)
        : [],
      timezone: String(sportsConfig.timezone || 'UTC').trim().slice(0, 64) || 'UTC'
    };
    account.updatedAt = new Date().toISOString();
    await this.save();
    return account;
  }

  async setSportsManifestVersion(accountId, version) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return null;
    const normalizedVersion = String(version || '').trim().slice(0, 32);
    if (account.sportsManifestVersion === normalizedVersion) return account;
    account.sportsManifestVersion = normalizedVersion;
    account.sportsManifestSeenAt = new Date().toISOString();
    account.updatedAt = account.sportsManifestSeenAt;
    await this.save();
    return account;
  }

  async increment(accountId, key, amount = 1) {
    await this.initialize();
    const account = this.getAccount(accountId);
    if (!account) return;
    account.stats = account.stats || {};
    account.stats[key] = Number(account.stats[key] || 0) + amount;
    account.lastActiveAt = new Date().toISOString();
    this.scheduleStatsSave();
  }

  hasPayment(transactionId) {
    const normalized = normalizeTransactionId(transactionId);
    return Boolean(normalized && this.store.payments[normalized]);
  }

  async recordPayment({ transactionId, email = '', amount = '', currency = '', paymentType = '', tokenHash = '', emailSentAt = null } = {}) {
    await this.initialize();
    const normalized = normalizeTransactionId(transactionId);
    if (!normalized) return null;
    this.store.payments[normalized] = {
      emailMasked: maskEmail(email),
      amount: String(amount || '').slice(0, 32),
      currency: String(currency || '').trim().toUpperCase().slice(0, 8),
      paymentType: String(paymentType || '').slice(0, 64),
      tokenHash: String(tokenHash || '').trim().toLowerCase(),
      emailHash: this.getPaymentEmailHash(email),
      createdAt: new Date().toISOString(),
      emailSentAt,
      claimedBy: null,
      claimedAt: null
    };
    await this.save();
    return this.store.payments[normalized];
  }

  getStats() {
    return {
      accounts: Object.keys(this.store.accounts || {}).length,
      active: Object.values(this.store.accounts || {}).filter((account) => this.isAccountActive(account)).length,
      trials: Object.values(this.store.tokens || {}).filter((token) => normalizeTier(token?.tier) === 'trial').length,
      tokens: Object.keys(this.store.tokens || {}).length,
      payments: Object.keys(this.store.payments || {}).length
    };
  }
}

export { normalizeUsername };
