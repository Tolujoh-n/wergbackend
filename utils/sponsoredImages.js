/** Normalize sponsored image entries from legacy string URLs or { url, link }. */
function normalizeSponsoredImageEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const url = entry.trim();
    return url ? { url, link: '' } : null;
  }
  const url = String(entry.url || '').trim();
  if (!url) return null;
  return {
    url,
    link: String(entry.link || '').trim(),
  };
}

function normalizeSponsoredImages(images) {
  if (!Array.isArray(images)) return [];
  return images.map(normalizeSponsoredImageEntry).filter(Boolean);
}

module.exports = {
  normalizeSponsoredImageEntry,
  normalizeSponsoredImages,
};
