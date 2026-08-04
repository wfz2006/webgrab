import { escapeXml } from './package-utils.js';

export function buildGalleryIndex({ title, source, pages, missingCount = 0 }) {
  const safeTitle = escapeXml(title || 'WebGrab 漫画');
  const pageHtml = pages.map((name, index) =>
    `    <figure id="page-${index + 1}" tabindex="-1"><img src="${escapeXml(name)}" alt="第 ${index + 1} 页" loading="lazy"><figcaption>${index + 1} / ${pages.length}</figcaption></figure>`
  ).join('\n');
  const warning = missingCount > 0 ? `<p class="warning">缺失 ${missingCount} 页，已保留其余可读内容。</p>` : '';
  const sourceLine = source ? `<a href="${escapeXml(source)}" target="_blank" rel="noreferrer">来源页面</a>` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;padding:.7rem 1rem;background:#111d;backdrop-filter:blur(8px);display:flex;gap:1rem;align-items:center}
h1{font-size:1rem;margin:0;flex:1}.warning{color:#ffd166;margin:.4rem 1rem}a{color:#8ecae6}main{max-width:1200px;margin:auto}
figure{margin:0 0 12px;text-align:center;scroll-margin-top:64px}img{display:block;max-width:100%;width:auto;height:auto;margin:auto;background:#222}figcaption{padding:.25rem;color:#aaa;font-size:.8rem}
</style></head><body><header><h1>${safeTitle}</h1><span>${pages.length} 页</span>${sourceLine}</header>${warning}<main>
${pageHtml}
</main><script>
(()=>{const pages=[...document.querySelectorAll('figure')];let current=0;const go=(delta)=>{if(!pages.length)return;current=Math.max(0,Math.min(pages.length-1,current+delta));pages[current].scrollIntoView({behavior:'smooth',block:'start'});pages[current].focus({preventScroll:true})};addEventListener('keydown',(event)=>{if(['ArrowRight','ArrowDown','PageDown',' '].includes(event.key)){event.preventDefault();go(1)}else if(['ArrowLeft','ArrowUp','PageUp'].includes(event.key)){event.preventDefault();go(-1)}else if(event.key==='Home'){current=0;go(0)}else if(event.key==='End'){current=pages.length-1;go(0)}})})();
</script></body></html>`;
}
