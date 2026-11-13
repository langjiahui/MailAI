/* Shared state convergence and module registry for MailAI frontend modules. */
(() => {
  const registry = new Map();
  const state = {
    account: {id: '', user: '', unified: false},
    mailbox: {specialMailbox: '', serverFolder: '', selectedEmailId: null, total: 0},
    todos: {open: false, accountId: '', count: 0, loading: false},
    compose: {open: false, accountId: '', mode: 'compose', draftId: null},
    ui: {view: 'mailbox', theme: 'light', language: 'zh-CN'},
  };
  const listeners = new Map();

  function cloneSlice(slice) {
    const current = state[slice];
    return current && typeof current === 'object' ? {...current} : current;
  }

  function notify(slice, next, prev) {
    const subs = listeners.get(slice);
    if (!subs?.size) return;
    subs.forEach(fn => {
      try { fn(cloneSlice(slice), prev ? {...prev} : prev, slice); } catch (_) {}
    });
  }

  window.MailAIModules = {
    register(name, exports = {}) {
      const key = String(name || '').trim();
      if (!key) return exports;
      const entry = Object.freeze({...exports});
      registry.set(key, entry);
      window.dispatchEvent(new CustomEvent('mailai:module-registered', {detail: {name: key}}));
      return entry;
    },
    get(name) {
      return registry.get(String(name || '').trim()) || null;
    },
    has(name) {
      return registry.has(String(name || '').trim());
    },
    list() {
      return [...registry.keys()];
    },
  };

  window.MailAIState = {
    get(slice) {
      if (!slice) return this.snapshot();
      return cloneSlice(slice);
    },
    set(slice, patch) {
      if (!Object.prototype.hasOwnProperty.call(state, slice) || !patch || typeof patch !== 'object') return cloneSlice(slice);
      const prev = {...state[slice]};
      let changed = false;
      const next = {...prev};
      for (const [k, v] of Object.entries(patch)) {
        if (!Object.is(prev[k], v)) {
          next[k] = v;
          changed = true;
        }
      }
      if (!changed) return next;
      state[slice] = next;
      notify(slice, next, prev);
      return {...next};
    },
    subscribe(slice, handler) {
      if (typeof handler !== 'function') return () => {};
      if (!listeners.has(slice)) listeners.set(slice, new Set());
      const bucket = listeners.get(slice);
      bucket.add(handler);
      return () => bucket.delete(handler);
    },
    snapshot() {
      return {
        account: {...state.account},
        mailbox: {...state.mailbox},
        todos: {...state.todos},
        compose: {...state.compose},
        ui: {...state.ui},
      };
    },
  };

  window.MailAICore = {
    readStorage(key, fallback = '') {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch (_) {
        return fallback;
      }
    },
    writeStorage(key, value) {
      try {
        localStorage.setItem(key, String(value));
        return true;
      } catch (_) {
        return false;
      }
    },
    bindBackdropClose(selector, onClose) {
      const node = document.querySelector(selector);
      if (!node || typeof onClose !== 'function') return null;
      node.addEventListener('click', onClose);
      return node;
    },
  };

  window.MailAIModules.register('state', {
    state: window.MailAIState,
    core: window.MailAICore,
  });
})();
