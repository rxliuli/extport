import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_FIREFOX_MIN_VERSION } from './firefox-port-manifest'

export const COMPAT_FIREFOX_RUNTIME_NAME = '__extport_firefox_runtime.js'
export const COMPAT_FIREFOX_BG_WRAPPER_NAME = '__extport_firefox_bg.js'

const HEAD_OPEN_RE = /<head\b[^>]*>/i
const HTML_OPEN_RE = /<html\b[^>]*>/i
const DOCTYPE_RE = /^\s*<!doctype\b[^>]*>/i

/**
 * Chrome-only permissions that Firefox's MV3 schema validator does not accept.
 * Stripping them avoids manifest warnings/errors while keeping all Firefox-supported
 * permissions intact.
 */
const CHROME_ONLY_PERMISSIONS = new Set([
  'offscreen',
  'sidePanel',
  'commands',
  'favicon',
  'fontSettings',
  'readingList',
  'debugger',
  'gcm',
  'system.cpu',
  'system.memory',
  'system.storage',
  'system.display',
  'tabCapture',
  'desktopCapture',
  'pageCapture',
  'power',
  'tts',
  'ttsEngine',
  'contentSettings',
  'documentScan',
  'enterprise.deviceAttributes',
  'enterprise.hardwarePlatform',
  'enterprise.networkingAttributes',
  'enterprise.platformKeys',
  'fileBrowserHandler',
  'fileSystemProvider',
  'loginState',
  'platformKeys',
  'printing',
  'printingMetrics',
  'processes',
  'vpnProvider',
  'wallpaper',
  'audio',
  'certificateProvider',
  'declarativeContent',
  'enterprise.kioskInput',
  'fileSystem',
  'signedInDevices',
  'webAuthenticationProxy',
])

const CHROME_ONLY_TOP_LEVEL_KEYS = [
  'update_url',
  'key',
  'minimum_chrome_version',
  'offline_enabled',
  '$schema',
  'oauth2',
  'sandbox',
  'externally_connectable',
  'version_name',
] as const

/**
 * Valid Firefox MV3 permissions that Firefox's schema only allows in
 * `permissions` (NOT `optional_permissions`). Moving them from
 * `optional_permissions` -> `permissions` eliminates manifest warnings
 * (e.g. Dark Reader's `contextMenus`, SingleFile's `identity`).
 */
const FIREFOX_NON_OPTIONAL_PERMISSIONS = new Set([
  'alarms',
  'contextMenus',
  'menus',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'identity',
  'storage',
  'unlimitedStorage',
])

function isUnsupportedPermission(perm: string): boolean {
  if (CHROME_ONLY_PERMISSIONS.has(perm)) return true
  if (/^chrome:\/\//i.test(perm)) return true
  return false
}

function normalizeManifestPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? ''
  const cleaned = withoutQuery.replace(/^(?:\.\/|\/)+/, '')
  return cleaned || undefined
}

function toRelativePosixHref(fromFilePosix: string, targetPosix: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFilePosix), targetPosix)
  return rel.startsWith('.') ? rel : `./${rel}`
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

export interface TransformFirefoxManifestOptions {
  geckoId: string
  minVersion?: string
}

/**
 * Transforms a Chrome MV3 manifest object in-place for Firefox MV3 compatibility.
 * Returns a list of human-readable transformation labels describing what changed.
 */
export function transformManifestForFirefox(
  manifest: Record<string, unknown>,
  options: TransformFirefoxManifestOptions,
): string[] {
  const changes: string[] = []

  // 1. browser_specific_settings.gecko (required for MV3 IDs, storage, DNR, signing)
  const bss =
    manifest.browser_specific_settings &&
    typeof manifest.browser_specific_settings === 'object' &&
    !Array.isArray(manifest.browser_specific_settings)
      ? (manifest.browser_specific_settings as Record<string, unknown>)
      : {}
  const gecko =
    bss.gecko && typeof bss.gecko === 'object' && !Array.isArray(bss.gecko)
      ? (bss.gecko as Record<string, unknown>)
      : {}
  gecko.id = options.geckoId
  if (options.minVersion) {
    gecko.strict_min_version = options.minVersion
  } else if (typeof gecko.strict_min_version !== 'string' || !gecko.strict_min_version.trim()) {
    gecko.strict_min_version = DEFAULT_FIREFOX_MIN_VERSION
  }
  if (!gecko.data_collection_permissions || typeof gecko.data_collection_permissions !== 'object') {
    gecko.data_collection_permissions = { required: ['none'] }
  }
  bss.gecko = gecko
  manifest.browser_specific_settings = bss
  changes.push(`gecko.id=${options.geckoId}`)

  // 2. background.service_worker -> background.scripts (Firefox rejects service_worker-only MV3)
  if (manifest.background && typeof manifest.background === 'object' && !Array.isArray(manifest.background)) {
    const bg = manifest.background as Record<string, unknown>
    if (typeof bg.service_worker === 'string' && bg.service_worker.trim()) {
      const swPath = bg.service_worker.trim()
      if (!Array.isArray(bg.scripts) || bg.scripts.length === 0) {
        bg.scripts = [swPath]
      }
      delete bg.service_worker
      changes.push('background.service_worker → background.scripts')
    }
  }

  // 3. incognito: "split" is unsupported in Firefox (only "spanning" or "not_allowed")
  if (manifest.incognito === 'split') {
    delete manifest.incognito
    changes.push('removed incognito=split')
  }

  // 4. options_page -> options_ui (options_page is deprecated / warned in Firefox MV3)
  if (typeof manifest.options_page === 'string' && manifest.options_page.trim()) {
    if (!manifest.options_ui || typeof manifest.options_ui !== 'object') {
      manifest.options_ui = { page: manifest.options_page.trim(), open_in_tab: true }
    }
    delete manifest.options_page
    changes.push('options_page → options_ui')
  }

  // Firefox MV3 warns when options_ui.browser_style is set (removed in MV3).
  if (manifest.options_ui && typeof manifest.options_ui === 'object' && !Array.isArray(manifest.options_ui)) {
    const optUi = manifest.options_ui as Record<string, unknown>
    if ('browser_style' in optUi) {
      delete optUi.browser_style
      changes.push('removed options_ui.browser_style')
    }
  }

  // Firefox requires `author` to be a string; Chrome MV3 allows `{ email, name }`.
  if (manifest.author && typeof manifest.author === 'object' && !Array.isArray(manifest.author)) {
    const authorObj = manifest.author as Record<string, unknown>
    const name = typeof authorObj.name === 'string' ? authorObj.name.trim() : ''
    const email = typeof authorObj.email === 'string' ? authorObj.email.trim() : ''
    const formatted = name && email ? `${name} <${email}>` : name || email
    if (formatted) {
      manifest.author = formatted
    } else {
      delete manifest.author
    }
    changes.push('normalized author to string')
  }

  // 5. side_panel -> sidebar_action (Firefox's native sidebar UI)
  if (manifest.side_panel && typeof manifest.side_panel === 'object' && !Array.isArray(manifest.side_panel)) {
    const sp = manifest.side_panel as Record<string, unknown>
    if (typeof sp.default_path === 'string' && sp.default_path.trim() && !manifest.sidebar_action) {
      const sidebar: Record<string, unknown> = { default_panel: sp.default_path.trim() }
      const action =
        manifest.action && typeof manifest.action === 'object'
          ? (manifest.action as Record<string, unknown>)
          : undefined
      if (typeof action?.default_title === 'string' && action.default_title.trim()) {
        sidebar.default_title = action.default_title
      }
      if (action?.default_icon) {
        sidebar.default_icon = action.default_icon
      } else if (manifest.icons) {
        sidebar.default_icon = manifest.icons
      }
      manifest.sidebar_action = sidebar
      changes.push('side_panel → sidebar_action')
    }
    delete manifest.side_panel
  }

  // 6. Sanitize permissions & optional_permissions
  //    In Firefox MV3, `userScripts` is only valid in `optional_permissions`,
  //    while permissions like `contextMenus` and `identity` are only valid in `permissions`.
  const optionalPerms = Array.isArray(manifest.optional_permissions)
    ? (manifest.optional_permissions.filter((p): p is string => typeof p === 'string') as string[])
    : []
  const optionalSet = new Set(optionalPerms)
  let movedUserScripts = false
  let promotedOptional = 0
  let strippedPerms = 0

  const nextPerms: string[] = []
  if (Array.isArray(manifest.permissions)) {
    for (const item of manifest.permissions) {
      if (typeof item !== 'string') continue
      if (item === 'userScripts') {
        optionalSet.add('userScripts')
        movedUserScripts = true
        continue
      }
      if (isUnsupportedPermission(item)) {
        strippedPerms++
        continue
      }
      if (!nextPerms.includes(item)) nextPerms.push(item)
    }
  }

  if (Array.isArray(manifest.optional_permissions) || movedUserScripts) {
    const nextOpt: string[] = []
    for (const item of optionalSet) {
      if (isUnsupportedPermission(item)) {
        strippedPerms++
        continue
      }
      if (FIREFOX_NON_OPTIONAL_PERMISSIONS.has(item)) {
        if (!nextPerms.includes(item)) nextPerms.push(item)
        promotedOptional++
        continue
      }
      nextOpt.push(item)
    }
    if (nextOpt.length > 0) {
      manifest.optional_permissions = nextOpt
    } else {
      delete manifest.optional_permissions
    }
  }

  if (Array.isArray(manifest.permissions) || promotedOptional > 0) {
    manifest.permissions = nextPerms
  }
  if (movedUserScripts) changes.push('moved userScripts → optional_permissions')
  if (promotedOptional > 0) changes.push(`promoted ${promotedOptional} non-optional permission(s)`)
  if (strippedPerms > 0) changes.push(`stripped ${strippedPerms} Chrome-only permission(s)`)

  // 7. web_accessible_resources: strip Chrome-only `use_dynamic_url` & `extension_ids`
  if (Array.isArray(manifest.web_accessible_resources)) {
    let cleanedWar = false
    for (const entry of manifest.web_accessible_resources) {
      if (!entry || typeof entry !== 'object') continue
      const obj = entry as Record<string, unknown>
      if ('use_dynamic_url' in obj) {
        delete obj.use_dynamic_url
        cleanedWar = true
      }
      if ('extension_ids' in obj) {
        delete obj.extension_ids
        cleanedWar = true
      }
    }
    if (cleanedWar) changes.push('cleaned web_accessible_resources')
  }

  // 8. content_security_policy: strip `sandbox` key and unsupported `navigate-to` directive
  if (
    manifest.content_security_policy &&
    typeof manifest.content_security_policy === 'object' &&
    !Array.isArray(manifest.content_security_policy)
  ) {
    const csp = manifest.content_security_policy as Record<string, unknown>
    let cspChanged = false
    if ('sandbox' in csp) {
      delete csp.sandbox
      cspChanged = true
    }
    if (typeof csp.extension_pages === 'string') {
      const cleaned = csp.extension_pages
        .replace(/(?:^|;\s*)navigate-to\b[^;]*/gi, '')
        .replace(/^;\s*/, '')
        .trim()
      if (cleaned !== csp.extension_pages) {
        csp.extension_pages = cleaned
        cspChanged = true
      }
    }
    if (Object.keys(csp).length === 0) {
      delete manifest.content_security_policy
      cspChanged = true
    }
    if (cspChanged) changes.push('cleaned content_security_policy')
  }

  // 9. storage.managed_schema is Chrome-only in manifest.json (Firefox uses native manifests)
  if (
    manifest.storage &&
    typeof manifest.storage === 'object' &&
    !Array.isArray(manifest.storage) &&
    'managed_schema' in manifest.storage
  ) {
    const storageObj = manifest.storage as Record<string, unknown>
    delete storageObj.managed_schema
    if (Object.keys(storageObj).length === 0) delete manifest.storage
    changes.push('stripped storage.managed_schema')
  }

  // 10. Strip Chrome-only top-level keys
  let strippedMeta = false
  for (const key of CHROME_ONLY_TOP_LEVEL_KEYS) {
    if (key in manifest) {
      delete manifest[key]
      strippedMeta = true
    }
  }
  if (strippedMeta) changes.push('stripped Chrome-only manifest keys')

  return changes
}

/**
 * Generates an external, MV3 CSP-safe Firefox runtime compatibility shim:
 * 1. Bridges `chrome.sidePanel` to `browser.sidebarAction` when available.
 * 2. Exposes `scripting.ExecutionWorld` enum (`ISOLATED` / `MAIN`) if missing.
 * 3. Provides a lightweight `globalThis.clients` ServiceWorker compatibility
 *    shim in Firefox Event Pages (`window` context) so extensions calling
 *    `self.clients.matchAll({ type: 'window' })` (e.g. Stylus) work cleanly.
 * 4. Wraps `permissions.contains` / `request` / `remove` so queries for
 *    stripped Chrome-only permissions resolve to `false` instead of throwing.
 * 5. Ensures `action.setBadgeTextColor` / `getBadgeTextColor` and
 *    `webRequest.On*Options` exist when omitted.
 */
export function buildFirefoxRuntimeShim(): string {
  return `/* Generated by extport for Firefox WebExtension runtime compatibility. */
(() => {
  const g = globalThis;
  if (g.__EXTPORT_FIREFOX_SHIM__) return;
  g.__EXTPORT_FIREFOX_SHIM__ = true;

  const INVALID_PERM_RE = /invalid permission|not a valid permission|must either|unknown permission|Type error for parameter/i;

  const patchNamespace = (api) => {
    if (!api || typeof api !== 'object') return;

    // 1. chrome.sidePanel -> browser.sidebarAction bridge
    try {
      if (!api.sidePanel && api.sidebarAction) {
        const sb = api.sidebarAction;
        api.sidePanel = {
          open(_options, callback) {
            const p = typeof sb.open === 'function' ? Promise.resolve(sb.open()) : Promise.resolve();
            if (typeof callback === 'function') {
              p.then(() => callback(), () => callback());
              return;
            }
            return p;
          },
          setOptions(options, callback) {
            const panel = options && typeof options.path === 'string' ? options.path : null;
            const details = {};
            if (panel !== null) details.panel = panel;
            if (options && typeof options.tabId === 'number') details.tabId = options.tabId;
            const p =
              typeof sb.setPanel === 'function' && 'panel' in details
                ? Promise.resolve(sb.setPanel(details))
                : Promise.resolve();
            if (typeof callback === 'function') {
              p.then(() => callback(), () => callback());
              return;
            }
            return p;
          },
          getOptions(options, callback) {
            const details = options && typeof options.tabId === 'number' ? { tabId: options.tabId } : {};
            const p =
              typeof sb.getPanel === 'function'
                ? Promise.resolve(sb.getPanel(details)).then((panel) => ({
                    path: panel || '',
                    enabled: Boolean(panel),
                  }))
                : Promise.resolve({ path: '', enabled: false });
            if (typeof callback === 'function') {
              p.then((res) => callback(res), () => callback({ path: '', enabled: false }));
              return;
            }
            return p;
          },
          setPanelBehavior(_behavior, callback) {
            if (typeof callback === 'function') {
              queueMicrotask(() => callback());
              return;
            }
            return Promise.resolve();
          },
          getPanelBehavior(callback) {
            const res = { openPanelOnActionClick: false };
            if (typeof callback === 'function') {
              queueMicrotask(() => callback(res));
              return;
            }
            return Promise.resolve(res);
          },
        };
      }
    } catch {}

    // 2. chrome.scripting.ExecutionWorld enum
    try {
      if (api.scripting && !api.scripting.ExecutionWorld) {
        api.scripting.ExecutionWorld = Object.freeze({
          ISOLATED: 'ISOLATED',
          MAIN: 'MAIN',
        });
      }
    } catch {}

    // 3. chrome.permissions.contains / request / remove tolerance for stripped Chrome-only permissions
    try {
      if (api.permissions) {
        for (const method of ['contains', 'request', 'remove']) {
          const orig = api.permissions[method];
          if (typeof orig !== 'function' || orig.__extportWrapped) continue;
          const bound = orig.bind(api.permissions);
          const wrapped = function (details, callback) {
            if (typeof callback === 'function') {
              try {
                return bound(details, callback);
              } catch (err) {
                if (INVALID_PERM_RE.test(String(err))) {
                  queueMicrotask(() => callback(false));
                  return;
                }
                throw err;
              }
            }
            try {
              const res = bound(details);
              if (res && typeof res.then === 'function') {
                return res.catch((err) => {
                  if (INVALID_PERM_RE.test(String(err))) return false;
                  throw err;
                });
              }
              return res;
            } catch (err) {
              if (INVALID_PERM_RE.test(String(err))) return Promise.resolve(false);
              throw err;
            }
          };
          wrapped.__extportWrapped = true;
          api.permissions[method] = wrapped;
        }
      }
    } catch {}

    // 4. chrome.webRequest option enums (when omitted)
    try {
      if (api.webRequest) {
        const optionEnums = {
          OnBeforeRequestOptions: { BLOCKING: 'blocking', REQUEST_BODY: 'requestBody' },
          OnBeforeSendHeadersOptions: { BLOCKING: 'blocking', REQUEST_HEADERS: 'requestHeaders' },
          OnSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders' },
          OnHeadersReceivedOptions: { BLOCKING: 'blocking', RESPONSE_HEADERS: 'responseHeaders' },
          OnAuthRequiredOptions: {
            BLOCKING: 'blocking',
            ASYNC_BLOCKING: 'asyncBlocking',
            RESPONSE_HEADERS: 'responseHeaders',
          },
          OnResponseStartedOptions: { RESPONSE_HEADERS: 'responseHeaders' },
          OnBeforeRedirectOptions: { RESPONSE_HEADERS: 'responseHeaders' },
          OnCompletedOptions: { RESPONSE_HEADERS: 'responseHeaders' },
        };
        for (const [k, v] of Object.entries(optionEnums)) {
          if (!api.webRequest[k]) {
            api.webRequest[k] = Object.freeze(v);
          }
        }
      }
    } catch {}

    // 5. chrome.action.setBadgeTextColor / getBadgeTextColor fallback
    try {
      if (api.action) {
        if (typeof api.action.setBadgeTextColor !== 'function') {
          api.action.setBadgeTextColor = function (_details, callback) {
            if (typeof callback === 'function') {
              queueMicrotask(() => callback());
              return;
            }
            return Promise.resolve();
          };
        }
        if (typeof api.action.getBadgeTextColor !== 'function') {
          api.action.getBadgeTextColor = function (_details, callback) {
            const color = [255, 255, 255, 255];
            if (typeof callback === 'function') {
              queueMicrotask(() => callback(color));
              return;
            }
            return Promise.resolve(color);
          };
        }
      }
    } catch {}

    // 6. declarativeNetRequest.updateDynamicRules / updateSessionRules: strip Chrome 128+
    //    responseHeaders / excludedResponseHeaders condition fields unsupported in Firefox.
    try {
      if (api.declarativeNetRequest) {
        const stripUnsupportedDnrCondition = (options) => {
          if (!options || typeof options !== 'object' || !Array.isArray(options.addRules)) return options;
          let modified = false;
          const nextAddRules = options.addRules.map((rule) => {
            if (!rule || typeof rule !== 'object' || !rule.condition || typeof rule.condition !== 'object') return rule;
            if (!('responseHeaders' in rule.condition) && !('excludedResponseHeaders' in rule.condition)) return rule;
            modified = true;
            const nextCond = Object.assign({}, rule.condition);
            delete nextCond.responseHeaders;
            delete nextCond.excludedResponseHeaders;
            return Object.assign({}, rule, { condition: nextCond });
          });
          return modified ? Object.assign({}, options, { addRules: nextAddRules }) : options;
        };
        for (const method of ['updateDynamicRules', 'updateSessionRules']) {
          const orig = api.declarativeNetRequest[method];
          if (typeof orig !== 'function' || orig.__extportWrapped) continue;
          const bound = orig.bind(api.declarativeNetRequest);
          const wrapped = function (options, ...rest) {
            const cleaned = stripUnsupportedDnrCondition(options);
            return bound(cleaned, ...rest);
          };
          wrapped.__extportWrapped = true;
          api.declarativeNetRequest[method] = wrapped;
        }
      }
    } catch {}
  };

  // 7. Lightweight navigator.serviceWorker stub in Firefox Event Pages (fixes SingleFile et al.)
  try {
    if (typeof g.navigator !== 'undefined' && !g.navigator.serviceWorker) {
      const swStub = {
        controller: null,
        ready: new Promise(() => {}),
        oncontrollerchange: null,
        onmessage: null,
        onmessageerror: null,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
        getRegistration: async () => undefined,
        getRegistrations: async () => [],
      };
      Object.defineProperty(g.navigator, 'serviceWorker', {
        value: swStub,
        configurable: true,
      });
    }
  } catch {}

  // 8. Lightweight ServiceWorkerGlobalScope.clients shim for Firefox Event Pages
  try {
    if (typeof g.window !== 'undefined' && !g.clients) {
      const extApi = g.browser || g.chrome;
      const toClient = (win, idx) => ({
        id: String(idx),
        url: (win && win.location && win.location.href) || '',
        type: 'window',
        frameType: 'top-level',
        focused: Boolean(win && win.document && typeof win.document.hasFocus === 'function' && win.document.hasFocus()),
        visibilityState: (win && win.document && win.document.visibilityState) || 'visible',
        postMessage(msg) {
          try {
            if (win && typeof win.postMessage === 'function') win.postMessage(msg, '*');
          } catch {}
        },
        focus() {
          try {
            if (win && typeof win.focus === 'function') win.focus();
          } catch {}
          return Promise.resolve(this);
        },
      });
      g.clients = {
        async matchAll() {
          try {
            if (extApi && extApi.extension && typeof extApi.extension.getViews === 'function') {
              const views = extApi.extension.getViews().filter((w) => w !== g.window);
              return views.map(toClient);
            }
          } catch {}
          return [];
        },
        async get() {
          return undefined;
        },
        async claim() {},
        async openWindow(url) {
          if (extApi && extApi.tabs && typeof extApi.tabs.create === 'function') {
            await extApi.tabs.create({ url });
          }
          return null;
        },
      };
    }
  } catch {}

  const seen = new Set();
  for (const ns of [g.chrome, g.browser]) {
    if (ns && !seen.has(ns)) {
      seen.add(ns);
      patchNamespace(ns);
    }
  }
})();
`
}

export function injectScriptIntoHtml(html: string, scriptHref: string): string {
  if (html.includes(COMPAT_FIREFOX_RUNTIME_NAME)) return html
  const scriptTag = `<script src="${scriptHref}"></script>`

  const headOpenMatch = HEAD_OPEN_RE.exec(html)
  if (headOpenMatch) {
    const insertPos = headOpenMatch.index + headOpenMatch[0].length
    return `${html.slice(0, insertPos)}\n    ${scriptTag}${html.slice(insertPos)}`
  }

  const headBlock = `<head>\n    ${scriptTag}\n  </head>`
  const htmlOpenMatch = HTML_OPEN_RE.exec(html)
  if (htmlOpenMatch) {
    const insertPos = htmlOpenMatch.index + htmlOpenMatch[0].length
    return `${html.slice(0, insertPos)}\n  ${headBlock}${html.slice(insertPos)}`
  }

  const doctypeMatch = DOCTYPE_RE.exec(html)
  if (doctypeMatch) {
    const insertPos = doctypeMatch.index + doctypeMatch[0].length
    return `${html.slice(0, insertPos)}\n${headBlock}\n${html.slice(insertPos)}`
  }

  return `${headBlock}\n${html}`
}

export function collectFirefoxHtmlPages(manifest: Record<string, unknown>): string[] {
  const action =
    manifest.action && typeof manifest.action === 'object' ? (manifest.action as Record<string, unknown>) : undefined
  const optionsUi =
    manifest.options_ui && typeof manifest.options_ui === 'object'
      ? (manifest.options_ui as Record<string, unknown>)
      : undefined
  const sidebarAction =
    manifest.sidebar_action && typeof manifest.sidebar_action === 'object'
      ? (manifest.sidebar_action as Record<string, unknown>)
      : undefined

  const candidates = [action?.default_popup, optionsUi?.page, sidebarAction?.default_panel, manifest.devtools_page]
  const seen = new Set<string>()
  const pages: string[] = []
  for (const candidate of candidates) {
    const normalized = normalizeManifestPath(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    pages.push(normalized)
  }
  return pages
}

async function wireFirefoxBackgroundRuntimeShim(root: string, manifest: Record<string, unknown>): Promise<boolean> {
  const bg = manifest.background
  if (!bg || typeof bg !== 'object' || Array.isArray(bg)) return false
  const background = bg as Record<string, unknown>
  if (!Array.isArray(background.scripts) || background.scripts.length === 0) return false

  const isModule = background.type === 'module'
  if (isModule) {
    const validScripts: string[] = []
    for (const s of background.scripts) {
      const normalized = normalizeManifestPath(s)
      if (!normalized) continue
      if (path.posix.basename(normalized) === COMPAT_FIREFOX_BG_WRAPPER_NAME) return false
      const full = path.resolve(root, normalized)
      const rel = path.relative(root, full)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (await isRegularFile(full)) {
        validScripts.push(rel.split(path.sep).join('/'))
      }
    }
    if (validScripts.length === 0) return false

    const firstDir = path.posix.dirname(validScripts[0]!)
    const wrapperPosix =
      firstDir === '.' ? COMPAT_FIREFOX_BG_WRAPPER_NAME : path.posix.join(firstDir, COMPAT_FIREFOX_BG_WRAPPER_NAME)
    const runtimeHref = toRelativePosixHref(wrapperPosix, COMPAT_FIREFOX_RUNTIME_NAME)
    const imports = [
      `import ${JSON.stringify(runtimeHref)};`,
      ...validScripts.map((scriptPosix) => `import ${JSON.stringify(toRelativePosixHref(wrapperPosix, scriptPosix))};`),
    ]
    await writeFile(path.join(root, ...wrapperPosix.split('/')), `${imports.join('\n')}\n`, 'utf-8')
    background.scripts = [wrapperPosix]
    return true
  }

  const alreadyPresent = background.scripts.some(
    (s) => typeof s === 'string' && normalizeManifestPath(s) === COMPAT_FIREFOX_RUNTIME_NAME,
  )
  if (alreadyPresent) return false
  background.scripts = [COMPAT_FIREFOX_RUNTIME_NAME, ...background.scripts]
  return true
}

/**
 * Webpack 5 bundles compiled for Chrome MV3 service workers emit an
 * `importScripts`-based chunk loader:
 *   `i.f.i=(t,r)=>{e[t]||importScripts(i.p+i.u(t))}`
 * In Firefox's MV3 Event Page (`window` context), `importScripts` does not
 * exist, causing dynamic chunks (e.g. Bitwarden's background chunks) to throw
 * `ReferenceError: importScripts is not defined`.
 *
 * Patching that exact Webpack 5 chunk loader to fall back to `<script>` tag
 * loading (pushing the load promise onto webpack's `r` promises array) keeps
 * MV3 CSP compliance (`script-src 'self'`) while preserving normal SW behavior.
 */
const WEBPACK_IMPORT_SCRIPTS_RE =
  /([A-Za-z_$][\w$]*)\.f\.i=\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)=>\{([A-Za-z_$][\w$]*)\[\2\]\|\|importScripts\(\1\.p\+\1\.u\(\2\)\)\}/g

export function patchWebpackImportScriptsLoader(code: string): string {
  return code.replace(
    WEBPACK_IMPORT_SCRIPTS_RE,
    '$1.f.i=($2,$3)=>{if(!$4[$2]){if(typeof importScripts==="function"){importScripts($1.p+$1.u($2))}else{$3.push(new Promise((_res,_rej)=>{const _s=document.createElement("script");_s.src=$1.p+$1.u($2);_s.onload=()=>_res();_s.onerror=_rej;(document.head||document.documentElement).appendChild(_s)}))}}}',
  )
}

async function patchBackgroundScriptsForEventPage(root: string, manifest: Record<string, unknown>): Promise<boolean> {
  const bg = manifest.background
  if (!bg || typeof bg !== 'object' || Array.isArray(bg)) return false
  const scripts = (bg as Record<string, unknown>).scripts
  if (!Array.isArray(scripts)) return false

  let patchedAny = false
  for (const script of scripts) {
    const normalized = normalizeManifestPath(script)
    if (!normalized || normalized === COMPAT_FIREFOX_RUNTIME_NAME) continue
    const full = path.resolve(root, normalized)
    const rel = path.relative(root, full)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (!(await isRegularFile(full))) continue
    const code = await readFile(full, 'utf-8').catch(() => undefined)
    if (!code || !code.includes('importScripts(')) continue
    const updated = patchWebpackImportScriptsLoader(code)
    if (updated !== code) {
      await writeFile(full, updated, 'utf-8')
      patchedAny = true
    }
  }
  return patchedAny
}

export interface PatchFirefoxExtensionResult {
  changes: string[]
  patchedPages: string[]
}

/**
 * Converts a staged unpacked Chrome MV3 extension directory in-place into a
 * Firefox-compatible MV3 extension.
 */
export async function patchExtensionForFirefox(
  unpackedDir: string,
  options: TransformFirefoxManifestOptions,
): Promise<PatchFirefoxExtensionResult> {
  const root = path.resolve(unpackedDir)
  const manifestPath = path.join(root, 'manifest.json')
  const raw = (await readFile(manifestPath, 'utf-8')).replace(/^\uFEFF/, '')
  const manifest = JSON.parse(raw) as Record<string, unknown>

  const changes = transformManifestForFirefox(manifest, options)

  const htmlPages = collectFirefoxHtmlPages(manifest)
  const targets: { relPosix: string; fullPath: string }[] = []
  for (const page of htmlPages) {
    const fullPath = path.resolve(root, page)
    const rel = path.relative(root, fullPath)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (!(await isRegularFile(fullPath))) continue
    targets.push({ relPosix: rel.split(path.sep).join('/'), fullPath })
  }

  if (await patchBackgroundScriptsForEventPage(root, manifest)) {
    changes.push('patched webpack importScripts chunk loader for Event Page')
  }

  const hasBackground = Boolean(manifest.background && typeof manifest.background === 'object')
  if (hasBackground || targets.length > 0) {
    await writeFile(path.join(root, COMPAT_FIREFOX_RUNTIME_NAME), buildFirefoxRuntimeShim(), 'utf-8')
  }

  await wireFirefoxBackgroundRuntimeShim(root, manifest)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

  const patchedPages: string[] = []
  for (const target of targets) {
    const scriptHref = toRelativePosixHref(target.relPosix, COMPAT_FIREFOX_RUNTIME_NAME)
    const original = await readFile(target.fullPath, 'utf-8')
    const updated = injectScriptIntoHtml(original, scriptHref)
    if (updated !== original) {
      await writeFile(target.fullPath, updated, 'utf-8')
      patchedPages.push(target.relPosix)
    }
  }

  return { changes, patchedPages }
}
