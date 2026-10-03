"""Build a standalone printable HTML guide using only the standard library."""
from html import escape
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "docs" / "APP_GUIDE.md").read_text()
parts = []
navigation = []
for block in source.strip().split("\n\n"):
    if block.startswith("# "):
        parts.append(f"<h1>{escape(block[2:])}</h1>")
    elif block.startswith("## "):
        title = block[3:]
        anchor = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        navigation.append(f'<li><a href="#{anchor}">{escape(title)}</a></li>')
        parts.append(f'<h2 id="{anchor}">{escape(title)}</h2>')
    else:
        parts.append(f"<p>{escape(block)}</p>")
html = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuietVault application guide</title>
<style>
:root {color-scheme:light} * {box-sizing:border-box}
body {margin:0; background:#f5f4ef; color:#182f2a; font:17px/1.7 system-ui,sans-serif}
main {max-width:850px; margin:48px auto; padding:50px 64px; background:#fff}
h1 {font-size:38px; line-height:1.2; color:#111; margin:0 0 24px}
h2 {font-size:24px; line-height:1.35; margin-top:44px; color:#111; break-after:avoid}
p {margin:0 0 18px; orphans:3; widows:3}
a {color:#235749} nav {margin:32px 0} nav ol {columns:2; padding-left:22px}
nav li {break-inside:avoid; padding:3px 0; font-size:14px}
.meta {font-size:13px; color:#57645f; letter-spacing:.03em; margin-bottom:24px}
@media(max-width:700px) {main {margin:0; padding:28px} nav ol {columns:1}}
@media print {body {background:white; color:black; font:11pt/1.5 Georgia,serif}
main {max-width:none; margin:0; padding:0} h1 {font-size:25pt} h2 {font-size:16pt}
nav {display:none} a {color:inherit; text-decoration:none} @page {size:A4; margin:22mm}}
</style></head><body><main>
"""
html += '<div class="meta">QUIETVAULT 1.0.0 · APPLICATION GUIDE · 5,000 WORDS</div>'
html += parts[0] + parts[1]
html += '<nav aria-label="Contents"><h2>Contents</h2><ol>' + ''.join(navigation) + '</ol></nav>'
html += '\n'.join(parts[2:]) + '</main></body></html>\n'
(ROOT / "docs" / "APP_GUIDE.html").write_text(html)
print(f"Built printable guide; Markdown source count: {len(source.split()):,} words")
