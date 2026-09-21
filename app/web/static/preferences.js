/* Persist the existing localStorage preference API outside the changing origin.
 * Tiny, infrequent settings writes are synchronous deliberately: once a toggle
 * returns, quitting the native window cannot discard a queued save. No mail,
 * credentials or attachment data is accepted by this allowlisted store. */
(() => {
  const seed = window.mailaiPreferenceSeed;
  if (!seed || typeof seed !== 'object') return;
  const keys = new Set([
    'mailai.preferences.theme.v1','mailai.preferences.showServerFolders.v1',
    'mailai-language','mailai-density','mailai-font-scale','mailai-companion-motion',
    'mailai-assistant-floating','mailai-assistant-layout-v1','mailai.workspace.paneSizes.v1',
    'mailai-browsing-account','mailai.onboarding.v2',
  ]);
  const allowed = key => keys.has(key) || /^(alias:|collapsed:|mailai-secretary-focus:)[\w.-]*$/.test(key);
  const store = window.localStorage;
  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  const save = (key, value) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/ui-preferences', false);
    request.setRequestHeader('Content-Type', 'application/json');
    request.send(JSON.stringify({key, value}));
    if (request.status !== 200) throw new Error('本地偏好保存失败');
    seed[key] = value;
  };
  // Migrate only currently accessible legacy preferences; disk wins otherwise.
  for (const key of Object.keys(store)) {
    if (allowed(key) && !Object.hasOwn(seed, key)) {
      try { save(key, nativeGet.call(store, key)); } catch (error) { console.warn(error); }
    }
  }
  Storage.prototype.getItem = function(key) {
    if (this === store && allowed(key) && Object.hasOwn(seed, key)) return seed[key];
    return nativeGet.call(this, key);
  };
  const change = (storage, key, value, nativeOperation) => {
    if (storage === store && allowed(key)) {
      try { save(key, value); }
      catch (error) {
        window.alert('设置未能保存到本地，请检查磁盘空间或目录权限后重试。');
        throw error;
      }
    }
    try { nativeOperation(); } catch (error) {
      if (!(storage === store && allowed(key))) throw error;
    }
  };
  Storage.prototype.setItem = function(key, value) {
    change(this, String(key), String(value), () => nativeSet.call(this, key, value));
  };
  Storage.prototype.removeItem = function(key) {
    change(this, String(key), null, () => nativeRemove.call(this, key));
  };
})();
