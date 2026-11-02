/* Keep portable setup values free of credential-bearing URLs and key material. */
(function(root) {
  'use strict';
  function assertPortable(value) {
    const visit = item => {
      if (typeof item === 'string') {
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:token|password|passwd|secret|api[_-]?key)\s*[=:]\s*\S+|\bBearer\s+\S+/i.test(item)) {
          throw new Error('Remove credentials or private keys before sharing or exporting a setup.');
        }
        for (const match of item.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
          let url;
          try { url = new URL(match[0]); } catch { throw new Error('A setup URL is invalid.'); }
          // Query strings and fragments may carry signed tokens with arbitrary names.
          if (url.username || url.password || url.search || url.hash) {
            throw new Error('Use public URLs without credentials, query strings, or fragments in portable setups.');
          }
        }
      } else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object') Object.values(item).forEach(visit);
    };
    visit(value);
    return value;
  }
  const api = Object.freeze({assertPortable});
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  root.TboxSetupSafety=api;
})(globalThis);
