/**
 * 扩展安装/更新后，为已经打开且符合 manifest 匹配规则的标签页补注入内容脚本。
 *
 * 这里刻意镜像 manifest.json 的 content_scripts 声明。修改任一处时，测试会要求
 * 两边同步，避免自愈路径悄悄扩大或缩小注入范围。
 */
export const CONTENT_SCRIPT_RECOVERY_RULES = Object.freeze([
  Object.freeze({
    matches: Object.freeze(['<all_urls>']),
    files: Object.freeze(['injected/hook.js']),
    world: 'MAIN',
    allFrames: true,
    installFlag: '__webgrabHookInstalled',
  }),
  Object.freeze({
    matches: Object.freeze(['*://*.bilibili.com/*']),
    files: Object.freeze(['content/bilibili-probe.js']),
    world: 'MAIN',
    allFrames: false,
    installFlag: '__webgrabBiliProbeInstalled',
  }),
  Object.freeze({
    matches: Object.freeze(['*://*.douyin.com/*']),
    files: Object.freeze(['content/douyin-probe.js']),
    world: 'MAIN',
    allFrames: false,
    installFlag: '__webgrabDouyinProbeInstalled',
  }),
  Object.freeze({
    matches: Object.freeze(['<all_urls>']),
    files: Object.freeze(['content/bridge.js']),
    world: 'ISOLATED',
    allFrames: true,
    installFlag: '__webgrabBridgeInstalled',
  }),
  Object.freeze({
    matches: Object.freeze(['<all_urls>']),
    files: Object.freeze(['content/scanner.js']),
    world: 'ISOLATED',
    allFrames: true,
    installFlag: '__webgrabScannerInstalled',
  }),
  Object.freeze({
    matches: Object.freeze(['<all_urls>']),
    files: Object.freeze([
      'lib/novel-heuristics.js',
      'lib/novel-extractor.js',
      'content/novel.js',
    ]),
    world: 'ISOLATED',
    allFrames: false,
    installFlag: '__webgrabNovelInstalled',
  }),
  Object.freeze({
    matches: Object.freeze(['http://*/*', 'https://*/*']),
    files: Object.freeze(['content/floating-companion.js']),
    world: 'ISOLATED',
    allFrames: false,
    installFlag: '__webgrabFloatingCompanionInstalled',
    removeStaleCompanion: true,
  }),
]);

const ALL_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:']);

function matchesPattern(urlValue, pattern) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }

  if (pattern === '<all_urls>') return ALL_URL_PROTOCOLS.has(url.protocol);
  if (pattern === 'http://*/*') return url.protocol === 'http:';
  if (pattern === 'https://*/*') return url.protocol === 'https:';
  if (pattern === '*://*.bilibili.com/*') {
    return ['http:', 'https:'].includes(url.protocol)
      && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'));
  }
  if (pattern === '*://*.douyin.com/*') {
    return ['http:', 'https:'].includes(url.protocol)
      && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
  }
  return false;
}

function ruleMatchesTab(rule, tab) {
  return typeof tab?.url === 'string'
    && rule.matches.some((pattern) => matchesPattern(tab.url, pattern));
}

// executeScript(func) 会序列化函数体，所以下面两个函数必须保持无闭包依赖。
function clearInstalledFlag(flagName) {
  try {
    if (!Reflect.deleteProperty(globalThis, flagName)) {
      globalThis[flagName] = false;
    }
  } catch {
    globalThis[flagName] = false;
  }
}

function removeStaleFloatingCompanion() {
  document.getElementById('webgrab-floating-companion')?.remove();
}

/**
 * 对当前已打开标签页执行尽力而为的补注入。
 * 每一组 executeScript 独立捕获错误，单页/单 frame 的访问限制不会中断后续规则。
 */
export async function recoverOpenTabs(chromeApi = globalThis.chrome, logger = console) {
  const tabs = await chromeApi.tabs.query({});
  const summary = { tabs: tabs.length, attempted: 0, succeeded: 0, failed: 0 };

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id)) continue;
    for (const rule of CONTENT_SCRIPT_RECOVERY_RULES) {
      if (!ruleMatchesTab(rule, tab)) continue;
      summary.attempted += 1;
      try {
        const target = { tabId: tab.id, allFrames: rule.allFrames };
        await chromeApi.scripting.executeScript({
          target,
          func: clearInstalledFlag,
          args: [rule.installFlag],
          world: rule.world,
        });
        if (rule.removeStaleCompanion) {
          await chromeApi.scripting.executeScript({
            target,
            func: removeStaleFloatingCompanion,
            world: rule.world,
          });
        }
        await chromeApi.scripting.executeScript({
          target,
          files: [...rule.files],
          world: rule.world,
        });
        summary.succeeded += 1;
      } catch (error) {
        summary.failed += 1;
        logger?.warn?.(
          `[WebGrab] 内容脚本自愈注入失败: tab=${tab.id} files=${rule.files.join(',')}`,
          error
        );
      }
    }
  }

  return summary;
}
