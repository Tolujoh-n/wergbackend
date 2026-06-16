const fs = require('fs');
const path = require('path');

/** Built-in high-signal disposable domains (always blocked). */
const BUILTIN_DISPOSABLE = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'sharklasers.com',
  'grr.la',
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'throwaway.email',
  'yopmail.com',
  'yopmail.fr',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
  'fakeinbox.com',
  'trashmail.com',
  'trashmail.me',
  'mailnesia.com',
  'mintemail.com',
  'emailondeck.com',
  'spamgourmet.com',
  'mytemp.email',
  'tmpmail.net',
  'tmpmail.org',
  'burnermail.io',
  'mailcatch.com',
  'mailpoof.com',
  'inboxkitten.com',
  'mohmal.com',
  'dropmail.me',
  'getairmail.com',
  'mail.tm',
  'mail.gw',
  'mail7.io',
  '1secmail.com',
  '1secmail.net',
  '1secmail.org',
  'emailfake.com',
  'crazymailing.com',
  'tempr.email',
  'discard.email',
  'discardmail.com',
  'spambox.us',
  'mailnull.com',
  'spam4.me',
  'mailscrap.com',
]);

let externalDomains = null;

function loadExternalDisposableList() {
  if (externalDomains !== null) return externalDomains;
  externalDomains = new Set();
  try {
    const listPath = path.join(__dirname, 'disposableEmailDomains.txt');
    if (fs.existsSync(listPath)) {
      const raw = fs.readFileSync(listPath, 'utf8');
      raw
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line && !line.startsWith('#'))
        .forEach((d) => externalDomains.add(d));
    }
  } catch {
    externalDomains = new Set();
  }
  return externalDomains;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function extractDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at < 1) return null;
  return normalized.slice(at + 1);
}

function isDisposableEmail(email) {
  const domain = extractDomain(email);
  if (!domain) return false;
  if (BUILTIN_DISPOSABLE.has(domain)) return true;
  const external = loadExternalDisposableList();
  if (external.has(domain)) return true;
  // Block obvious subdomains of known disposable roots
  for (const blocked of BUILTIN_DISPOSABLE) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function assertAllowedEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const err = new Error('Enter a valid email address');
    err.statusCode = 400;
    throw err;
  }
  if (isDisposableEmail(normalized)) {
    const err = new Error(
      'Disposable or temporary email addresses are not allowed. Please use a permanent email.'
    );
    err.statusCode = 400;
    err.code = 'DISPOSABLE_EMAIL';
    throw err;
  }
  return normalized;
}

module.exports = {
  normalizeEmail,
  isDisposableEmail,
  assertAllowedEmail,
};
