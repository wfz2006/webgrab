import { createPathContext, renderPathTemplate } from '../lib/path-planner.js';
import { DEFAULT_PATH_SETTINGS, loadPathSettings, loadPreviewContext, savePathSettings } from '../lib/path-settings.js';
import { DEFAULT_COMPANION_SETTINGS, loadCompanionSettings, saveCompanionSettings } from '../lib/companion-settings.js';
import { DEFAULT_UI_SETTINGS, applyTheme, loadUiSettings, saveUiSettings, watchUiSettings } from '../lib/ui-settings.js';
import { DEFAULT_RESOURCE_FILTERS, loadResourceFilters, saveResourceFilters } from '../lib/resource-filter-settings.js';
import { DEFAULT_DOWNLOAD_SETTINGS, loadDownloadSettings, saveDownloadSettings } from '../lib/download-settings.js';
import { DEFAULT_PACKAGE_PREFERENCE, loadPackagePreference, savePackagePreference } from '../lib/package-preference.js';

const form = document.getElementById('settings-form');
const previewType = document.getElementById('preview-type');
const preview = document.getElementById('path-preview');
const previewMeta = document.getElementById('preview-meta');
const saveStatus = document.getElementById('save-status');
const resetButton = document.getElementById('reset-settings');
const companionEnabled = document.getElementById('companion-enabled');
const companionHiddenSites = document.getElementById('companion-hidden-sites');
const companionRestoreSites = document.getElementById('companion-restore-sites');
const uiTheme = document.getElementById('ui-theme');
const companionCharacter = document.getElementById('companion-character');
const filterExt = document.getElementById('filter-ext');
const filterMime = document.getElementById('filter-mime');
const filterMinImage = document.getElementById('filter-min-image');
const filterMinVideo = document.getElementById('filter-min-video');
const filterMinAudio = document.getElementById('filter-min-audio');
const filterUrlPatterns = document.getElementById('filter-url-patterns');
const filterHookResources = document.getElementById('filter-hook-resources');
const perfSegmentConcurrency = document.getElementById('perf-segment-concurrency');
const perfRetryCount = document.getElementById('perf-retry-count');
const packagePreferenceSelect = document.getElementById('package-preference');
const exportSettingsBtn = document.getElementById('export-settings');
const importSettingsBtn = document.getElementById('import-settings');
const importSettingsFile = document.getElementById('import-settings-file');
const templateInputs = new Map([...document.querySelectorAll('[data-template-type]')].map((input) => [input.dataset.templateType, input]));
const samples = {
  comic:{type:'comic',site:'动漫屋',work:'火锅家族第八季',chapter:'第27回 手链',sequence:'027',title:'第27回 手链',ext:'cbz'},
  novel:{type:'novel',site:'笔趣阁',work:'逆天邪神',title:'逆天邪神',ext:'epub'},
  video:{type:'video',site:'哔哩哔哩',title:'【互动视频】选择角色，结局由你来定',ext:'mp4'},
  audio:{type:'audio',site:'Example',title:'访谈节目 第12期',ext:'m4a'},
  image:{type:'image',site:'SomeACG',title:'146071231_p0',sequence:'001',date:'2026-07-31',ext:'png'},
  other:{type:'other',site:'Example',title:'resource',ext:'bin'},
};
let previewContext = null;
let activeTemplateInput = null;
let companionSettings = { ...DEFAULT_COMPANION_SETTINGS, disabledOrigins: [], positions: {} };
let uiSettings = { ...DEFAULT_UI_SETTINGS };
let resourceFilters = { ...DEFAULT_RESOURCE_FILTERS, minSizeBytes: { ...DEFAULT_RESOURCE_FILTERS.minSizeBytes } };
let downloadSettings = { ...DEFAULT_DOWNLOAD_SETTINGS };
let packagePreference = DEFAULT_PACKAGE_PREFERENCE;

async function populateCharacterOptions(selectedRoot) {
  let characters = [{ id: 'default', name: '默认占位角色', root: 'assets/character' }];
  try {
    const response = await fetch('../assets/character/registry.json');
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.characters) && data.characters.length) characters = data.characters;
    }
  } catch {
    // 保留内置兜底列表
  }
  companionCharacter.replaceChildren(...characters.map((character) => {
    const option = document.createElement('option');
    option.value = character.root;
    option.textContent = character.name || character.root;
    return option;
  }));
  if (![...companionCharacter.options].some((option) => option.value === selectedRoot)) {
    const custom = document.createElement('option');
    custom.value = selectedRoot;
    custom.textContent = `自定义（${selectedRoot}）`;
    companionCharacter.append(custom);
  }
  companionCharacter.value = selectedRoot;
}

function bytesToKb(bytes) { return Math.round((Number(bytes) || 0) / 1024); }
function kbToBytes(kb) { return Math.max(0, Math.round((Number(kb) || 0) * 1024)); }

function currentResourceFilters() {
  return {
    extBlacklist: filterExt.value.split(',').map((s) => s.trim()).filter(Boolean),
    mimeBlacklist: filterMime.value.split(',').map((s) => s.trim()).filter(Boolean),
    minSizeBytes: {
      image: kbToBytes(filterMinImage.value),
      video: kbToBytes(filterMinVideo.value),
      audio: kbToBytes(filterMinAudio.value),
    },
    urlBlacklistPatterns: filterUrlPatterns.value.split('\n').map((s) => s.trim()).filter(Boolean),
    showHookResources: filterHookResources.checked,
  };
}

function applyResourceFilters(filters) {
  resourceFilters = { ...filters, minSizeBytes: { ...filters.minSizeBytes } };
  filterExt.value = resourceFilters.extBlacklist.join(', ');
  filterMime.value = resourceFilters.mimeBlacklist.join(', ');
  filterMinImage.value = bytesToKb(resourceFilters.minSizeBytes.image);
  filterMinVideo.value = bytesToKb(resourceFilters.minSizeBytes.video);
  filterMinAudio.value = bytesToKb(resourceFilters.minSizeBytes.audio);
  filterUrlPatterns.value = resourceFilters.urlBlacklistPatterns.join('\n');
  filterHookResources.checked = resourceFilters.showHookResources !== false;
}

function currentDownloadSettings() {
  return {
    segmentConcurrency: Number(perfSegmentConcurrency.value),
    retryCount: Number(perfRetryCount.value),
  };
}

function applyDownloadSettings(settings) {
  downloadSettings = { ...settings };
  perfSegmentConcurrency.value = downloadSettings.segmentConcurrency;
  perfRetryCount.value = downloadSettings.retryCount;
}

function currentTemplates() { return Object.fromEntries([...templateInputs].map(([type,input]) => [type,input.value])); }
function renderPreview() {
  const type = previewType.value;
  const input = templateInputs.get(type);
  const context = createPathContext({...samples[type],...(previewContext?.type===type?previewContext:{}),type});
  const path = renderPathTemplate(input.value,context);
  preview.textContent = path;
  previewMeta.textContent = `${path.length}/260 字符 · 每级目录均按 Windows 规则清洗`;
}
function renderHiddenSites() {
  companionHiddenSites.replaceChildren();
  const origins = companionSettings.disabledOrigins || [];
  companionRestoreSites.disabled = origins.length === 0;
  companionHiddenSites.classList.toggle('empty', origins.length === 0);
  if (origins.length === 0) {
    companionHiddenSites.textContent = '没有被隐藏的站点。';
    return;
  }
  for (const origin of origins) {
    const chip = document.createElement('span');
    chip.className = 'site-chip';
    const label = document.createElement('span');
    label.textContent = origin;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.dataset.restoreOrigin = origin;
    restore.title = `恢复 ${origin}`;
    restore.setAttribute('aria-label', `恢复在 ${origin} 显示悬浮窗`);
    restore.textContent = '×';
    chip.append(label, restore);
    companionHiddenSites.append(chip);
  }
}
function applySettings(settings, nextCompanion = companionSettings, nextUi = uiSettings, nextFilters = resourceFilters, nextDownload = downloadSettings, nextPackagePreference = packagePreference) {
  for (const [type,input] of templateInputs) input.value = settings.templates[type];
  for (const radio of form.elements.conflict) radio.checked = radio.value === settings.conflictStrategy;
  companionSettings = { ...nextCompanion, disabledOrigins: [...(nextCompanion.disabledOrigins || [])], positions: { ...(nextCompanion.positions || {}) } };
  companionEnabled.checked = companionSettings.enabled !== false;
  uiSettings = { ...nextUi };
  uiTheme.value = uiSettings.theme;
  applyTheme(document.documentElement, uiSettings);
  applyResourceFilters(nextFilters);
  applyDownloadSettings(nextDownload);
  packagePreference = nextPackagePreference;
  packagePreferenceSelect.value = packagePreference;
  populateCharacterOptions(companionSettings.characterRoot || 'assets/character').catch(() => {});
  renderHiddenSites();
  renderPreview();
}
for (const input of templateInputs.values()) {
  input.addEventListener('focus',()=>{activeTemplateInput=input;previewType.value=input.dataset.templateType;renderPreview();});
  input.addEventListener('input',renderPreview);
}
previewType.addEventListener('change',renderPreview);
document.querySelector('.token-rail').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-token]'); if(!button)return;
  const input=activeTemplateInput||templateInputs.get(previewType.value);
  const start=input.selectionStart??input.value.length; const end=input.selectionEnd??start;
  input.setRangeText(button.dataset.token,start,end,'end'); input.focus(); input.dispatchEvent(new Event('input',{bubbles:true}));
});
form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const conflictStrategy=new FormData(form).get('conflict');
  companionSettings.enabled = companionEnabled.checked;
  companionSettings.characterRoot = companionCharacter.value || companionSettings.characterRoot;
  uiSettings.theme = uiTheme.value;
  await Promise.all([
    savePathSettings({templates:currentTemplates(),conflictStrategy}),
    saveCompanionSettings(companionSettings),
    saveUiSettings(uiSettings),
    saveResourceFilters(currentResourceFilters()),
    saveDownloadSettings(currentDownloadSettings()),
    savePackagePreference(packagePreferenceSelect.value),
  ]);
  saveStatus.textContent='已保存，后续任务将使用新路径。'; setTimeout(()=>{saveStatus.textContent='';},2500);
});
resetButton.addEventListener('click',()=>{applySettings(DEFAULT_PATH_SETTINGS, DEFAULT_COMPANION_SETTINGS, DEFAULT_UI_SETTINGS, DEFAULT_RESOURCE_FILTERS, DEFAULT_DOWNLOAD_SETTINGS, DEFAULT_PACKAGE_PREFERENCE);saveStatus.textContent='已恢复默认值，点击“保存设置”后生效。';});
uiTheme.addEventListener('change',()=>{uiSettings.theme=uiTheme.value;applyTheme(document.documentElement,uiSettings);});
companionRestoreSites.addEventListener('click',()=>{companionSettings.disabledOrigins=[];renderHiddenSites();saveStatus.textContent='已在表单中恢复全部站点，点击“保存设置”后生效。';});
companionHiddenSites.addEventListener('click',(event)=>{
  const button=event.target.closest('[data-restore-origin]'); if(!button)return;
  companionSettings.disabledOrigins=companionSettings.disabledOrigins.filter((origin)=>origin!==button.dataset.restoreOrigin);
  renderHiddenSites();
});
watchUiSettings((next)=>{uiSettings=next;uiTheme.value=next.theme;applyTheme(document.documentElement,next);});

exportSettingsBtn.addEventListener('click', async () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    pathSettings: { templates: currentTemplates(), conflictStrategy: new FormData(form).get('conflict') },
    companionSettings: { ...companionSettings, characterRoot: companionCharacter.value },
    uiSettings: { theme: uiTheme.value },
    resourceFilters: currentResourceFilters(),
    downloadSettings: currentDownloadSettings(),
    packagePreference: packagePreferenceSelect.value,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `webgrab-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  saveStatus.textContent = '已导出配置文件。';
  setTimeout(() => { saveStatus.textContent = ''; }, 2500);
});

importSettingsBtn.addEventListener('click', () => importSettingsFile.click());
importSettingsFile.addEventListener('change', async () => {
  const file = importSettingsFile.files?.[0];
  importSettingsFile.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    applySettings(
      { templates: { ...DEFAULT_PATH_SETTINGS.templates, ...(data.pathSettings?.templates || {}) }, conflictStrategy: data.pathSettings?.conflictStrategy || DEFAULT_PATH_SETTINGS.conflictStrategy },
      { ...DEFAULT_COMPANION_SETTINGS, ...(data.companionSettings || {}) },
      { ...DEFAULT_UI_SETTINGS, ...(data.uiSettings || {}) },
      { ...DEFAULT_RESOURCE_FILTERS, ...(data.resourceFilters || {}) },
      { ...DEFAULT_DOWNLOAD_SETTINGS, ...(data.downloadSettings || {}) },
      data.packagePreference || DEFAULT_PACKAGE_PREFERENCE,
    );
    saveStatus.textContent = '已读入配置，点击“保存设置”后生效。';
  } catch (error) {
    saveStatus.textContent = `导入失败：${error.message || error}`;
  }
});

Promise.all([loadPathSettings(),loadPreviewContext(),loadCompanionSettings(),loadUiSettings(),loadResourceFilters(),loadDownloadSettings(),loadPackagePreference()]).then(([settings,context,loadedCompanion,loadedUi,loadedFilters,loadedDownload,loadedPackagePreference])=>{
  previewContext=context;
  if(context?.type&&templateInputs.has(context.type))previewType.value=context.type;
  applySettings(settings, loadedCompanion, loadedUi, loadedFilters, loadedDownload, loadedPackagePreference);
  previewMeta.textContent=context?`${preview.textContent.length}/260 字符 · 使用 popup 当前选中资源预览`:`${preview.textContent.length}/260 字符 · 当前没有选中资源，使用示例数据`;
}).catch((error)=>{applySettings(DEFAULT_PATH_SETTINGS, DEFAULT_COMPANION_SETTINGS, DEFAULT_UI_SETTINGS, DEFAULT_RESOURCE_FILTERS, DEFAULT_DOWNLOAD_SETTINGS, DEFAULT_PACKAGE_PREFERENCE);saveStatus.textContent=`读取设置失败：${error.message||error}`;});
