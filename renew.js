const { chromium } = require('patchright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE = 'https://dash.daki.cc';
const STATE_FILE = path.join(process.cwd(), '.state', 'daki-state.json');

// ---------------- Telegram 通知：有图发图，没图发文字 ----------------
async function sendTelegram(token, chatId, message, photoPath) {
    if (!token || !chatId) {
        console.log('未配置 Telegram，跳过通知');
        return;
    }
    try {
        if (photoPath && fs.existsSync(photoPath)) {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('caption', message.slice(0, 1000));
            form.append('photo', fs.createReadStream(photoPath));
            await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, form, {
                headers: form.getHeaders(),
                timeout: 60000,
            });
        } else {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
            }, { timeout: 30000 });
        }
        console.log('通知已发送至 Telegram');
    } catch (e) {
        console.error('发送 TG 失败:', e.message);
    }
}

// ---------------- Cloudflare 验证 ----------------
async function isChallenge(page) {
    try {
        const title = await page.title();
        if (/just a moment|attention required|请稍候|security verification/i.test(title)) return true;
        const txt = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 800) : ''));
        return /Performing security verification|Verify you are human|Checking your browser|正在验证|执行安全验证/i.test(txt);
    } catch (e) {
        return true; // 页面正在跳转，视为尚未通过
    }
}

async function waitCloudflare(page, timeoutMs = 75000) {
    const start = Date.now();
    let noted = false;
    let lastClick = 0;
    while (Date.now() - start < timeoutMs) {
        if (!(await isChallenge(page))) {
            if (noted) console.log('Cloudflare 验证已通过');
            return true;
        }
        if (!noted) { console.log('检测到 Cloudflare 验证，等待通过...'); noted = true; }
        if (Date.now() - lastClick > 8000) {
            try {
                const frame = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
                if (await frame.count()) {
                    const box = await frame.boundingBox();
                    if (box) {
                        await page.mouse.move(box.x + 28, box.y + box.height / 2, { steps: 12 });
                        await page.mouse.click(box.x + 28, box.y + box.height / 2);
                        lastClick = Date.now();
                    }
                }
            } catch (e) {}
        }
        await page.waitForTimeout(3000);
    }
    return false;
}

async function gotoWithRetry(page, url, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            console.log(`访问 ${url} (第 ${i}/${tries} 次)`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
            if (!(await waitCloudflare(page))) throw new Error('Cloudflare 验证未通过');
            return;
        } catch (e) {
            lastErr = e;
            console.log(`第 ${i} 次访问失败: ${e.message.split('\n')[0]}`);
            if (i < tries) await page.waitForTimeout(8000 * i);
        }
    }
    throw lastErr;
}

// ---------------- 登录状态：保存 / 恢复 ----------------
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        console.log('读取登录状态失败，将重新登录:', e.message);
    }
    return null;
}

async function restoreState(context, state) {
    try {
        if (state.cookies && state.cookies.length) await context.addCookies(state.cookies);
        const items = state.localStorage || {};
        if (Object.keys(items).length) {
            const origin = state.origin || SITE;
            await context.addInitScript(({ data, origin }) => {
                if (location.origin !== origin) return;
                for (const [k, v] of Object.entries(data)) {
                    try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {}
                }
            }, { data: items, origin });
        }
        console.log(`已加载上次的登录状态 (cookie ${state.cookies ? state.cookies.length : 0} 个)`);
    } catch (e) {
        console.log('恢复登录状态失败:', e.message);
    }
}

async function saveState(context, page) {
    try {
        // 只保存 daki.cc 的 cookie，不保存 Discord 的
        const cookies = (await context.cookies()).filter((c) => /(^|\.)daki\.cc$/.test(c.domain));
        let localStorageItems = {};
        let origin = SITE;
        try {
            const u = new URL(page.url());
            if (/(^|\.)daki\.cc$/.test(u.hostname)) {
                origin = u.origin;
                localStorageItems = await page.evaluate(() => {
                    const o = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        o[k] = localStorage.getItem(k);
                    }
                    return o;
                });
            }
        } catch (e) {}
        // token 每次运行都会由 DISCORD_TOKEN 注入，不重复落盘
        delete localStorageItems.token;

        if (!cookies.length && !Object.keys(localStorageItems).length) {
            console.log('没有可保存的登录状态');
            return;
        }
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(
            STATE_FILE,
            JSON.stringify({ savedAt: new Date().toISOString(), origin, cookies, localStorage: localStorageItems }),
            { mode: 0o600 }
        );
        console.log(`登录状态已保存 (cookie ${cookies.length} 个)`);
    } catch (e) {
        console.log('保存登录状态失败:', e.message);
    }
}

// ---------------- 登录判断 ----------------
// 控制台里的 Renew 是链接(<a>)而不是 <button>，且页面上始终有 Discord 图标链接，
// 所以不再用"有没有 Discord 按钮"判断，只看是否出现已登录控制台的特征
async function isLoggedIn(page) {
    const renewBtn = page.locator('button:has-text("Renew"), a:has-text("Renew")').first();
    for (let i = 0; i < 30; i++) {
        if (await renewBtn.isVisible().catch(() => false)) return true;
        const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (/Free Tier Dashboard|Good (morning|afternoon|evening|night),|My servers|Renewals today/i.test(txt)) return true;
        await page.waitForTimeout(1000);
    }
    return false;
}

// ---------------- 打开续期确认弹窗 ----------------
async function openRenewDialog(page) {
    console.log('寻找续期按钮...');
    // 控制台是单页应用，点侧边栏 Servers 即可，不再硬编码域名
    const nav = page.locator('a:has-text("Servers")').first();
    if (await nav.isVisible().catch(() => false)) {
        await nav.click().catch(() => {});
        await page.waitForTimeout(3000);
    }
    const renewBtns = page.locator('button:has-text("Renew"), a:has-text("Renew"), .btn-success:has-text("Renew")');
    await renewBtns.first().waitFor({ state: 'visible', timeout: 60000 });
    const n = await renewBtns.count();
    for (let i = 0; i < n; i++) {
        const b = renewBtns.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        await b.click().catch(() => {});
        try {
            await page.waitForURL((u) => /heads-up|\/renew/.test(u.pathname), { timeout: 12000 });
            console.log('已进入续期流程页:', page.url());
            return;
        } catch (e) {
            console.log(`第 ${i + 1} 个续期按钮没有弹出确认框，尝试下一个`);
        }
    }
    throw new Error('点击续期按钮后没有进入续期流程页');
}

// ---------------- heads-up 确认页：勾选 + Continue to the renewal ----------------
async function confirmHeadsUp(page) {
    if (!/heads-up/.test(page.url())) {
        console.log('未出现 heads-up 确认页，当前地址:', page.url());
        return;
    }
    console.log('处理 heads-up 确认页...');
    const checkbox = page.locator('input[type="checkbox"]').first();
    try {
        await checkbox.check({ timeout: 8000 });
    } catch (e) {
        console.log('直接勾选失败，改为点击说明文字勾选');
        await page.getByText(/I understand that the ads/i).first().click();
    }
    const cont = page.locator('button:has-text("Continue"), a:has-text("Continue")').first();
    await cont.waitFor({ state: 'visible', timeout: 30000 });
    for (let i = 0; i < 15; i++) {          // 勾选后按钮才会可点
        if (await cont.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(1000);
    }
    await cont.click();
    console.log('已点击 Continue to the renewal');
    // 页面说明里提到可能先出现一段视频广告，这里最多等 90 秒进入真正的续期页
    await page.waitForURL((u) => /\/servers\/[^/]+\/renew/.test(u.pathname), { timeout: 90000 });
    console.log('已进入续期倒计时页:', page.url());
}

async function claimRenewal(page) {
    console.log('等待倒计时结束...');
    const claim = page.locator('button:has-text("Claim"), a:has-text("Claim"), button:has-text("领取")').first();

    // 倒计时期间页面上没有 Claim 按钮，计时结束才出现；以 "Timer complete" 或按钮出现为准，最多 6 分钟
    const start = Date.now();
    let lastLog = 0;
    let done = false;
    while (Date.now() - start < 360000) {
        if (await claim.isVisible().catch(() => false)) { done = true; break; }
        const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (/Timer complete/i.test(txt)) { done = true; break; }
        if (Date.now() - lastLog > 20000) {
            const m = txt.match(/(\d+:\d{2})\s*remaining/i);
            console.log(`  倒计时中... 页面剩余 ${m ? m[1] : '未知'}，已等待 ${Math.round((Date.now() - start) / 1000)} 秒`);
            lastLog = Date.now();
        }
        await page.waitForTimeout(3000);
    }
    if (!done) throw new Error('等待 6 分钟仍未出现 Claim 按钮');
    console.log('倒计时已结束');

    await claim.waitFor({ state: 'visible', timeout: 30000 });
    console.log('尝试点击领取...');
    try {
        await claim.click({ timeout: 8000 });
    } catch (e) {
        console.log('常规点击失败（可能被广告遮挡），改用脚本点击');
        await claim.evaluate((el) => el.click());
    }
}

// ---------------- Discord 授权页：必须先滚到底，按钮才会激活 ----------------
async function handleDiscordAuthorize(page) {
    try {
        await page.waitForURL((u) => u.hostname.includes('discord.com'), { timeout: 30000 });
    } catch (e) {
        console.log('未跳转到 Discord 授权页，可能已自动登录。');
        return;
    }
    console.log('进入 Discord 授权页...');
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
    const scrollBtn = page.locator('button:has-text("Keep Scrolling"), button:has-text("继续滚动")').first();

    for (let i = 0; i < 20; i++) {
        if (!new URL(page.url()).hostname.includes('discord.com')) return; // 已经跳回
        if ((await authBtn.isVisible().catch(() => false)) && (await authBtn.isEnabled().catch(() => false))) {
            console.log('点击授权按钮...');
            await authBtn.click();
            return;
        }
        console.log('授权按钮未激活，向下滚动权限列表...');
        // 把页面里所有可滚动容器都滚到底
        await page.evaluate(() => {
            document.querySelectorAll('*').forEach((el) => {
                if (el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
                    el.scrollTop = el.scrollHeight;
                }
            });
        }).catch(() => {});
        await page.mouse.move(640, 420);
        await page.mouse.wheel(0, 3000);
        if (await scrollBtn.isVisible().catch(() => false)) {
            await scrollBtn.click({ timeout: 2000 }).catch(() => {});
        }
        await page.waitForTimeout(1500);
    }
    throw new Error('Discord 授权按钮始终未激活');
}

async function loginViaDiscord(page) {
    await gotoWithRetry(page, SITE);
    console.log('点击 Discord 登录...');
    const loginBtn = page.locator('button:has-text("Discord"), a:has-text("Discord")').first();
    await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
    await loginBtn.click();

    await handleDiscordAuthorize(page);

    // 授权后会跳回 daki.cc 下的控制台（实际落在 free.daki.cc），不限定具体子域名
    await page.waitForURL((u) => /(^|\.)daki\.cc$/.test(u.hostname), { timeout: 90000 });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await waitCloudflare(page);
}

// ---------------- 主流程 ----------------
(async () => {
    const launchOpts = {
        channel: 'chrome',   // 真实 Chrome
        headless: false,     // 有头模式，工作流里用 xvfb 提供虚拟屏幕
        viewport: null,
    };
    if (process.env.IS_PROXY === 'true') {
        const proxyServer = process.env.PROXY_SERVER || 'socks5://127.0.0.1:1080';
        launchOpts.proxy = { server: proxyServer };
        console.log('浏览器使用本地代理:', proxyServer);
    } else {
        console.log('浏览器直连（未启用代理）');
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
    const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    context.setDefaultTimeout(60000);
    context.setDefaultNavigationTimeout(90000);

    // 兜底登录方式：注入 Discord Token
    const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
    await context.addInitScript((token) => {
        try { localStorage.setItem('token', `"${token}"`); } catch (e) {}
    }, DISCORD_TOKEN);

    const page = context.pages()[0] || (await context.newPage());
    let failed = false;

    try {
        // 1) 优先用上次保存的登录状态
        let loggedIn = false;
        const state = loadState();
        if (state) {
            await restoreState(context, state);
            console.log('尝试使用已保存的登录状态...');
            await gotoWithRetry(page, `${state.origin || SITE}/`);
            loggedIn = await isLoggedIn(page);
            console.log(loggedIn ? '登录状态有效，跳过 Discord 登录' : '登录状态已失效，改用 Discord 登录');
        } else {
            console.log('没有已保存的登录状态，使用 Discord 登录');
        }

        if (!loggedIn) {
            await loginViaDiscord(page);
            loggedIn = await isLoggedIn(page);
            if (!loggedIn) throw new Error('Discord 授权后仍未进入已登录状态');
        }
        console.log('已进入控制台:', page.url());

        // 登录成功立刻保存，后面续期即使失败也不会丢
        await saveState(context, page);

        await openRenewDialog(page);
        await page.waitForTimeout(1000);

        await confirmHeadsUp(page);
        await claimRenewal(page);

        console.log('等待最终结果...');
        await page.waitForTimeout(15000);
        await page.screenshot({ path: 'result.png', fullPage: true });
        await saveState(context, page); // 刷新一次保存的状态

        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            '✅ Daki 自动续期任务执行完毕！',
            'result.png'
        );
    } catch (err) {
        failed = true;
        console.error('运行出错:', err);
        await page.screenshot({ path: 'error.png' }).catch(() => {});
        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            `❌ Daki 续期失败: ${String(err.message).split('\n')[0]}\n页面: ${page.url()}`,
            'error.png'
        );
    } finally {
        await context.close().catch(() => {});
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }

    if (failed) process.exit(1);
})();
