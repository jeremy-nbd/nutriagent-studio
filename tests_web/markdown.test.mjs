import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown as render } from '../public/markdown.js';

test('headings, spaced bold markers, lists and nested lists', () => {
  const html = render('## 饮食观察\n\n**观察： ** 已记录一餐。\n\n1. **补充蔬菜**\n   - 叶菜\n   - 菌菇\n2. 下一餐再记录');
  assert.match(html, /<h4>饮食观察<\/h4>/);
  assert.match(html, /<strong>观察：<\/strong>/);
  assert.match(html, /<ol start="1">/);
  assert.match(html, /<ul><li><p>叶菜/);
  assert.doesNotMatch(html, /\*\*/);
});
test('tables, quotes and code preserve text', () => {
  const html = render('| 营养素 | 数值 |\n| --- | ---: |\n| 蛋白质 | 30g |\n\n> 仅统计已记录部分\n\n```html\n<script>alert(1)</script>\n```');
  assert.match(html, /<th scope="col">营养素/);
  assert.match(html, /<td>30g<\/td>/);
  assert.match(html, /<blockquote><p>仅统计/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
});
test('untrusted HTML, unsafe URL schemes and images cannot execute or load', () => {
  const html = render('<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](data:text/html,test) ![照片](https://tracker.invalid/pixel)\n\n[来源](https://example.com/?a=1&b=2)');
  assert.doesNotMatch(html, /<(?:script|img|iframe)|href="(?:javascript|data):/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /tracker.invalid/);
});
test('partial streaming markers stay inert and completed text formats', () => {
  assert.equal(render('**建议'), '<p>**建议</p>');
  assert.equal(render('**建议**'), '<p><strong>建议</strong></p>');
  assert.equal(render('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
  assert.doesNotMatch(render('[x](https://example.com/"onmouseover="x)'), / onmouseover="/);
});
