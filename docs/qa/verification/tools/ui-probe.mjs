#!/usr/bin/env node
/**
 * UI 探针（verifier 用，只读）：通过 Chrome DevTools Protocol 打开若干页面，
 * 抽取可见文本 + 截图，用于从「用户视角」核对界面承诺（不修改数据）。
 *
 * 前置：已有一个 --remote-debugging-port=<port> 的 Chrome/Edge 实例。
 * 用法：
 *   node ui-probe.mjs <cdpPort> <outDir> <name1>=<url1> [<name2>=<url2> ...]
 * 例：
 *   node ui-probe.mjs 9223 docs/qa/verification/screenshots inbox=http://127.0.0.1:5213/inbox accounts=http://127.0.0.1:5213/accounts
 *
 * 输出：每个页面一个 <name>.txt（可见文本）与 <name>.png（截图）；stdout 汇总 JSON。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdpPort, outDir, ...pairs] = process.argv.slice(2);
if (!cdpPort || !outDir || pairs.length === 0) {
  console.error('用法：node ui-probe.mjs <cdpPort> <outDir> <name>=<url> ...');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('CDP 没有可用的 page target');
  return page.webSocketDebuggerUrl;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function main() {
  const wsUrl = await targetWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const results = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const url = pair.slice(eq + 1);
    await cdp.send('Page.navigate', { url });
    await sleep(3200);
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({
        title: document.title,
        text: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n'),
        hasIdentityBlock: Boolean(document.querySelector('[data-testid^="identity-block-"]')),
        hasFirstRunGuide: Boolean(document.querySelector('.first-run-guide')),
        hasFooter: Boolean(document.querySelector('.rail__footer, footer')),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        accountCards: Array.from(document.querySelectorAll('[data-testid^="account-card-"]')).map((el) => ({
          testid: el.getAttribute('data-testid'),
          text: (el.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 900),
        })),
        identityBlocks: Array.from(document.querySelectorAll('[data-testid^="identity-block-"]')).map((el) => ({
          testid: el.getAttribute('data-testid'),
          text: (el.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 500),
        })),
      }))()`,
      returnByValue: true,
    });
    const value = evaluated.result.value ?? {};
    writeFileSync(join(outDir, `${name}.txt`), value.text ?? '', 'utf8');
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    } catch {
      /* 截图失败不影响文本证据 */
    }
    results.push({
      name,
      url,
      title: value.title,
      textLength: (value.text ?? '').length,
      hasIdentityBlock: value.hasIdentityBlock,
      hasFirstRunGuide: value.hasFirstRunGuide,
      horizontalOverflow: (value.scrollWidth ?? 0) > (value.clientWidth ?? 0) + 1,
      accountCards: value.accountCards ?? [],
      identityBlocks: value.identityBlocks ?? [],
    });
  }
  console.log(JSON.stringify({ results }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});