/* App requests are intent, never installed inventory. */
(function(root) {
  const valid = typeof module !== 'undefined' && module.exports
    ? require('./builder-config.js').validFlatpakId : root.TboxBuilderConfig.validFlatpakId;
  function suggestions(facts, declared = []) {
    const inspected = Array.isArray(facts?.suggestedFlatpaks);
    return { ids: [...new Set((inspected ? facts.suggestedFlatpaks : declared).filter(valid))],
      source: inspected ? 'image inspection' : 'configuration declaration' };
  }
  function create() {
    let target = null, defaults = null, edited = false, selected = [], pending = false;
    return {
      edit(ids) { selected = [...ids]; edited = true; },
      inspect(key, next) {
        const changed = target !== null && target !== key;
        target = key; defaults = next;
        pending = pending || edited || changed;
        if (!pending) selected = next.ids.slice();
        return this.snapshot();
      },
      restore() { if (defaults) { selected = defaults.ids.slice(); edited = false; pending = false; } return this.snapshot(); },
      // Forget every earlier target and edit: the next inspect applies its defaults.
      reset() { target = null; defaults = null; edited = false; selected = []; pending = false; return this.snapshot(); },
      snapshot() { return { target, defaults, edited, selected: selected.slice(), pending }; },
    };
  }
  const api = { suggestions, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TboxFlatpakDefaults = api;
})(globalThis);
