/* 语义检索开关：依赖缺失时禁用开关并提示，依赖可用时正常渲染状态。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../app/web/static/workspace.js'), 'utf8');

const start = source.indexOf('async function loadSemanticStatus()');
const end = source.indexOf('async function loadWorkspacePreferences()');
assert.ok(start > 0 && end > start);

function harness({account = {id: 'a'}, prefs = {}, stats = {}, fail = false} = {}) {
  const label = {attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }};
  const reindex = {hidden: true};
  reindex.classList = {
    add() { reindex.hidden = true; },
    remove() { reindex.hidden = false; },
    toggle(_c, force) { reindex.hidden = force ?? !reindex.hidden; },
  };
  const nodes = {
    'semantic-status': {textContent: ''},
    'semantic-reindex': reindex,
    'semantic-enabled': {checked: false, disabled: false, closest: () => label},
  };
  const ctx = {
    document: {getElementById: id => nodes[id]},
    activeMailAccount: () => account,
    mailaiT: () => null,
    api: async url => {
      if (fail) throw new Error('offline');
      return url.includes('/api/preferences') ? prefs : stats;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return {ctx, nodes, label};
}

(async () => {
  // 依赖缺失：开关禁用 + 提示 + 隐藏重建按钮（不允许"开了但空转"）
  {
    const {ctx, nodes, label} = harness({stats: {deps_available: false}});
    await ctx.loadSemanticStatus();
    assert.equal(nodes['semantic-enabled'].disabled, true);
    assert.equal(nodes['semantic-enabled'].checked, false);
    assert.match(nodes['semantic-status'].textContent, /未安装可选依赖/);
    assert.equal(nodes['semantic-reindex'].hidden, true);
    assert.match(label.attrs.title || '', /requirements-semantic/);
  }
  // 依赖可用且已启用：开关可用，显示索引统计，重建按钮出现
  {
    const {ctx, nodes, label} = harness({
      prefs: {semantic_enabled: true},
      stats: {deps_available: true, enabled: true, indexed: 42, last_indexed_at: '2026-09-19T08:00:00'},
    });
    await ctx.loadSemanticStatus();
    assert.equal(nodes['semantic-enabled'].disabled, false);
    assert.equal(nodes['semantic-enabled'].checked, true);
    assert.match(nodes['semantic-status'].textContent, /42/);
    assert.equal(nodes['semantic-reindex'].hidden, false);
    assert.equal(label.attrs.title, undefined);
  }
  // 依赖可用但未启用：重建按钮保持隐藏
  {
    const {ctx, nodes} = harness({
      prefs: {semantic_enabled: false},
      stats: {deps_available: true, enabled: false, indexed: 0},
    });
    await ctx.loadSemanticStatus();
    assert.match(nodes['semantic-status'].textContent, /尚未建立索引/);
    assert.equal(nodes['semantic-reindex'].hidden, true);
  }
  // 无账号与接口失败
  {
    const {ctx, nodes} = harness({account: null});
    await ctx.loadSemanticStatus();
    assert.match(nodes['semantic-status'].textContent, /添加邮箱/);
  }
  {
    const {ctx, nodes} = harness({fail: true});
    await ctx.loadSemanticStatus();
    assert.match(nodes['semantic-status'].textContent, /暂时无法读取/);
  }
  console.log('Semantic toggle gating, status rendering and failure paths passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
