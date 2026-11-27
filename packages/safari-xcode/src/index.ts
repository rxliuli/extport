export {
  applyBundleIds,
  convertExtensionToXcodeProject,
  parseProjectVersion,
  readPbxObjects,
  resolveBundleIds,
  type ConvertExtensionToXcodeProjectOptions,
  type ConvertedXcodeProject,
  type PbxObject,
  type SafariProjectType,
} from './safari-xcode'
export { parseXcproj, patchXcproj, serializeXcproj, type XcprojProject, type XcprojSettings } from './safari-xcproj'
export {
  resizeMacWindow,
  resolveAppPaths,
  setupPageCss,
  setupPageHtml,
  setupPageScript,
  writeSetupPage,
  type SetupPageHtmlOptions,
  type WriteSetupPageOptions,
} from './safari-setup-page'
