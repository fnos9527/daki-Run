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
            await context.addInitScript((data) => {
                if (location.origin !== 'https://dash.daki.cc') return;
                for (const [k, v] of Object.entries(data)) {
                    try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {}
                }
            }, items);
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
        try {
            if (new URL(page.url()).origin === SITE) {
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
            JSON.stringify({ savedAt: new Date().toISOString(), cookies, localStorage: localStorageItems }),
            { mode: 0o600 }
        );
        console.log(`登录状态已保存 (cookie ${cookies.length} 个)`);
    } catch (e) {
        console.log('保存登录状态失败:', e.message);
    }
}

// ---------------- 登录判断 ----------------
async function isLoggedIn(page) {
    const loginBtn = page.locator('button:has-text("Discord"), a:has-text("Discord")').first();
    const renewBtn = page.locator('button:has-text("Renew"), .btn-success:has-text("Renew")').first();
    for (let i = 0; i < 20; i++) {
        if (await renewBtn.isVisible().catch(() => false)) return true;
        if (await loginBtn.isVisible().catch(() => false)) return false;
        await page.waitForTimeout(1000);
    }
    return /\/servers/.test(page.url());
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

    await page.waitForURL((u) => u.hostname === 'dash.daki.cc', { timeout: 90000 });
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
            await gotoWithRetry(page, `${SITE}/servers`);
            loggedIn = await isLoggedIn(page);
            console.log(loggedIn ? '登录状态有效，跳过 Discord 登录' : '登录状态已失效，改用 Discord 登录');
        } else {
            console.log('没有已保存的登录状态，使用 Discord 登录');
        }

        // 2) 失效或没有，走完整 Discord 登录
        if (!loggedIn) {
            await loginViaDiscord(page);
            console.log('进入服务器列表...');
            await gotoWithRetry(page, `${SITE}/servers`);
            loggedIn = await isLoggedIn(page);
            if (!loggedIn) throw new Error('Discord 登录后仍未进入已登录状态');
        }

        // 登录成功立刻保存，后面续期即使失败也不会丢
        await saveState(context, page);

        console.log('寻找续期按钮...');
        const renewBtn = page.locator('button:has-text("Renew"), .btn-success:has-text("Renew")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 60000 });
        await renewBtn.click();
        await page.waitForTimeout(3000);

        console.log('处理确认弹窗...');
        await page.locator('input[type="checkbox"]').first().check();
        await page.click('button:has-text("Continue")');

        console.log('进入倒计时页面，等待 185 秒...');
        await page.waitForTimeout(185000);

        console.log('尝试点击领取...');
        const claimButton = page.locator('button:has-text("领取"), button:has-text("Claim"), .btn-primary:has-text("3")').first();
        await claimButton.waitFor({ state: 'visible', timeout: 30000 });
        await claimButton.click();

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
            `❌ Daki 续期失败: ${String(err.message).split('\n')[0]}`,
            'error.png'
        );
    } finally {
        await context.close().catch(() => {});
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }

    if (failed) process.exit(1);
})();
