'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'docs/APP_GUIDE.md'), 'utf8');
const count = source.trim().split(/\s+/).length;
if (count !== 5000) throw new Error(`Guide must contain 5,000 words; found ${count}. Count includes headings and references.`);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const navigation = [];
const parts = source.trim().split(/\n\s*\n/).map(block => {
  if (block.startsWith('# ')) return `<h1>${escape(block.slice(2))}</h1>`;
  if (block.startsWith('## ')) {
    const title = block.slice(3), id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    navigation.push(`<li><a href="#${id}">${escape(title)}</a></li>`);
    return `<h2 id="${id}">${escape(title)}</h2>`;
  }
  return `<p>${escape(block)}</p>`;
});
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuietVault Node.js application guide</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f3ed;color:#233b32;font:17px/1.7 system-ui,sans-serif}main{max-width:850px;margin:48px auto;padding:50px 64px;background:#fff}h1{font-size:38px;line-height:1.2;color:#111;margin:0 0 24px}h2{font-size:24px;line-height:1.35;margin-top:44px;color:#111;break-after:avoid}p{margin:0 0 18px;orphans:3;widows:3}a{color:#285a47}nav{margin:32px 0}nav ol{columns:2;padding-left:22px}nav li{break-inside:avoid;padding:3px 0;font-size:14px}.meta{font-size:13px;color:#57645f;margin-bottom:24px}@media(max-width:700px){main{margin:0;padding:28px}nav ol{columns:1}}@media print{body{background:white;color:black;font:11pt/1.5 Georgia,serif}main{max-width:none;margin:0;padding:0}h1{font-size:25pt}h2{font-size:16pt}nav{display:none}a{color:inherit;text-decoration:none}@page{size:A4;margin:22mm}}
</style></head><body><main><div class="meta">QUIETVAULT 2.0 · ELECTRON AND NODE.JS · 5,000 WORDS</div>${parts[0]}${parts[1]}<nav aria-label="Contents"><h2>Contents</h2><ol>${navigation.join('')}</ol></nav>${parts.slice(2).join('\n')}</main></body></html>`;
fs.writeFileSync(path.join(root, 'docs/APP_GUIDE.html'), html);
console.log(`Built printable Node.js guide. Verified ${count.toLocaleString()} words, including headings and references.`);
