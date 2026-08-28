/*
 * End to end test for p2p-files.html and the signalling service.
 *
 * It starts the service, drives two real browsers, connects them, and checks
 * that the bytes that come out the far end are the bytes that went in.
 *
 *   npm install playwright && npx playwright install chromium
 *   node p2p-signal/test-e2e.js
 *
 * Set CHROMIUM_PATH if your Chromium lives somewhere Playwright will not find.
 */

const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8792);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOOLS = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-e2e-'));
const FIXTURE = path.join(WORK, 'payload.bin');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${ORIGIN}/p2p-signal/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function hashOfReceived(page, name) {
  return page.evaluate(async fileName => {
    const rows = Array.from(document.querySelectorAll('#receiveList .transfer'));
    const row = rows.find(r => r.querySelector('.transfer-name').textContent === fileName);
    if (!row) return null;
    const link = row.querySelector('a.download');
    if (!link) return null;
    const buffer = await (await fetch(link.href)).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return {
      hash: Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join(''),
      size: buffer.byteLength,
      download: link.getAttribute('download')
    };
  }, name);
}

async function transfer(from, to, fixturePath, label, onArrived) {
  const name = path.basename(fixturePath);
  const expected = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');

  await from.setInputFiles('#fileInput', fixturePath);
  await from.click('#sendBtn');

  await to.waitForFunction(fileName => {
    const rows = Array.from(document.querySelectorAll('#receiveList .transfer'));
    const row = rows.find(r => r.querySelector('.transfer-name').textContent === fileName);
    return !!(row && row.querySelector('a.download'));
  }, name, { timeout: 60000 });

  // Sample before hashing: hashing pulls the whole blob into the JS heap.
  if (onArrived) await onArrived();

  const got = await hashOfReceived(to, name);
  check(`${label}: bytes arrive intact`, !!got && got.hash === expected,
    got ? `${got.size} bytes, sha256 ${got.hash.slice(0, 12)}...` : 'no file');
  check(`${label}: filename preserved`, !!got && got.download === name, got ? got.download : '');

  const sent = await from.textContent('#sendList .transfer .transfer-detail');
  check(`${label}: sender reports completion`, /Sent/.test(sent || ''), (sent || '').trim());
}

(async () => {
  fs.writeFileSync(FIXTURE, crypto.randomBytes(6 * 1024 * 1024));
  const small = path.join(WORK, 'small.txt');
  fs.writeFileSync(small, 'hello from the other side\n'.repeat(50));

  const server = spawn('node', [path.join(TOOLS, 'p2p-signal', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SERVE_DIR: TOOLS, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', d => console.log('[server] ' + d.toString().trim()));

  let browser;
  try {
    await waitForServer();
    check('signalling service is up', true);

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox', '--js-flags=--expose-gc']
    });
    const context = await browser.newContext();
    const alice = await context.newPage();
    const bob = await context.newPage();
    for (const [who, page] of [['alice', alice], ['bob', bob]]) {
      page.on('pageerror', e => console.log(`[${who} pageerror] ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') console.log(`[${who} console] ${m.text()}`); });
    }

    // --- bad code path ---
    await bob.goto(`${ORIGIN}/p2p-files.html`);
    await bob.fill('#codeInput', 'ZZZZZZZZ');
    await bob.click('#joinBtn');
    await bob.waitForSelector('#errorBox:visible', { timeout: 10000 });
    const badMessage = (await bob.textContent('#errorBox')) || '';
    check('unknown code gives a real reason', /not valid/i.test(badMessage), badMessage.slice(0, 60));
    check('page recovers after a bad code', await bob.isVisible('#startArea'));

    // --- happy path ---
    await alice.goto(`${ORIGIN}/p2p-files.html`);
    await alice.click('#createBtn');
    await alice.waitForSelector('#codeDisplay:not(:empty)', { timeout: 15000 });
    const code = (await alice.textContent('#codeDisplay')).trim();
    check('sender gets an eight-character code', /^[A-HJ-NP-Z2-9]{8}$/.test(code), code);

    const qrPainted = await alice.evaluate(() => {
      const canvas = document.getElementById('qrCanvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
      return { dark, total: data.length / 4, size: canvas.width };
    });
    check('QR code is drawn', qrPainted.dark > qrPainted.total * 0.15 && qrPainted.dark < qrPainted.total * 0.6,
      `${qrPainted.size}px canvas, ${Math.round(qrPainted.dark * 100 / qrPainted.total)}% dark`);

    await bob.goto(`${ORIGIN}/p2p-files.html#c=${code}`);
    await Promise.all([
      alice.waitForSelector('#status.connected', { timeout: 30000 }),
      bob.waitForSelector('#status.connected', { timeout: 30000 })
    ]);
    check('scanning the QR link auto-connects both sides', true);

    check('address bar is tidied after connecting', !(await bob.evaluate(() => location.hash)));

    await transfer(alice, bob, FIXTURE, 'sender to receiver, 6 MB');
    await transfer(bob, alice, small, 'receiver back to sender');

    // Big enough to cross the send high-water mark many times and to trip the
    // receiver's Blob coalescing, which is what keeps memory flat.
    const big = path.join(WORK, 'big.bin');
    fs.writeFileSync(big, crypto.randomBytes(40 * 1024 * 1024));
    const heap = () => bob.evaluate(() => {
      if (typeof gc === 'function') gc();
      return performance.memory ? performance.memory.usedJSHeapSize : 0;
    });
    const beforeHeap = await heap();
    let afterHeap = 0;
    await transfer(alice, bob, big, 'sender to receiver, 40 MB', async () => { afterHeap = await heap(); });
    if (beforeHeap) {
      const growthMb = (afterHeap - beforeHeap) / (1024 * 1024);
      check('receiving 40 MB does not hold it all in memory', growthMb < 20,
        `heap grew ${growthMb.toFixed(1)} MB for a 40 MB file`);
    }

    // --- typing the code by hand, on a fresh pair of pages ---
    const carol = await context.newPage();
    const dave = await context.newPage();
    await carol.goto(`${ORIGIN}/p2p-files.html`);
    await carol.click('#createBtn');
    await carol.waitForSelector('#codeDisplay:not(:empty)', { timeout: 15000 });
    const typedCode = (await carol.textContent('#codeDisplay')).trim();

    await dave.goto(`${ORIGIN}/p2p-files.html`);
    await dave.fill('#codeInput', typedCode.toLowerCase());
    await dave.click('#joinBtn');
    await Promise.all([
      carol.waitForSelector('#status.connected', { timeout: 30000 }),
      dave.waitForSelector('#status.connected', { timeout: 30000 })
    ]);
    check('typing the code by hand connects, case insensitively', true);
    await transfer(dave, carol, small, 'typed-code pair');
    await carol.close();
    await dave.close();

    // --- signalling service unreachable ---
    const erin = await context.newPage();
    await erin.route('**/p2p-signal/**', route => route.abort());
    await erin.goto(`${ORIGIN}/p2p-files.html`);
    await erin.click('#createBtn');
    await erin.waitForSelector('#errorBox:visible', { timeout: 10000 });
    const downMessage = (await erin.textContent('#errorBox')) || '';
    check('a dead signalling service says so plainly', /Cannot reach the signalling service/.test(downMessage),
      downMessage.slice(0, 50) + '...');
    await erin.close();

    const stillOpen = await fetch(`${ORIGIN}/p2p-signal/health`).then(r => r.json());
    check('signalling session is discarded once used', stillOpen.sessions === 0, `sessions=${stillOpen.sessions}`);

    // --- reuse of a spent code ---
    const reuse = await fetch(`${ORIGIN}/p2p-signal/sessions/${code}`);
    check('a spent code cannot be reused', reuse.status === 404, `HTTP ${reuse.status}`);
  } catch (error) {
    check('run completed without throwing', false, error.message);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }

  fs.rmSync(WORK, { recursive: true, force: true });

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
