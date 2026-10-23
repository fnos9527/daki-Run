const { chromium } = require('patchright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE = 'https://dash.daki.cc';

// Telegram 通知：有图发图，没图发文字
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

// 是否停在 Cloudflare 验证页
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

// 等待 Cloudflare 验证通过，期间尝试点击 Turnstile 复选框
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

// 带重试的页面跳转：不等 networkidle，并处理 Cloudflare 验证
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

(async () => {
    const launchOpts = {
        channel: 'chrome',   // 真实 Chrome，比自带 Chromium 更不容易被识别
        headless: false,     // 有头模式，工作流里用 xvfb 提供虚拟屏幕
        viewport: null,
    };
    // 工作流 "Setup optional VLESS node" 成功后会设置 IS_PROXY=true，
    // 浏览器就走本机 sing-box 的 SOCKS5；否则直连
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

    const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

    // 在所有页面导航前注入 Token
    await context.addInitScript((token) => {
        try { localStorage.setItem('token', `"${token}"`); } catch (e) {}
    }, DISCORD_TOKEN);

    const page = context.pages()[0] || (await context.newPage());
    let failed = false;

    try {
        console.log('正在访问 Daki...');
        await gotoWithRetry(page, SITE);

        console.log('点击 Discord 登录...');
        const loginBtn = page.locator('button:has-text("Discord"), a:has-text("Discord")').first();
        await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
        await loginBtn.click();

        console.log('检查 Discord 授权状态...');
        try {
            const authButton = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
            await authButton.waitFor({ state: 'visible', timeout: 30000 });

            const scrollBtn = page.locator('button:has-text("Keep Scrolling")');
            if (await scrollBtn.isVisible()) {
                console.log('发现滚动按钮，正在向下滚动...');
                await scrollBtn.click();
                await page.waitForTimeout(1000);
            }

            console.log('点击授权按钮...');
            await authButton.click();
        } catch (e) {
            console.log('未检测到授权按钮，可能已自动登录。');
        }

        await page.waitForURL('**/dash.daki.cc/**', { timeout: 90000 });
        await waitCloudflare(page);

        console.log('进入服务器列表...');
        await gotoWithRetry(page, `${SITE}/servers`);

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

    // 失败时让 Actions 显示红叉，而不是假装成功
    if (failed) process.exit(1);
})();
