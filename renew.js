const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

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

// 带重试的页面跳转：不再等 networkidle（后台长连接/统计脚本会让它永远不"空闲"）
async function gotoWithRetry(page, url, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            console.log(`访问 ${url} (第 ${i}/${tries} 次)`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
            await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
            return;
        } catch (e) {
            lastErr = e;
            console.log(`第 ${i} 次访问失败: ${e.message.split('\n')[0]}`);
            if (i < tries) await page.waitForTimeout(10000 * i);
        }
    }
    throw lastErr;
}

(async () => {
    const launchOpts = {
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
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

    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    context.setDefaultTimeout(60000);
    context.setDefaultNavigationTimeout(90000);

    const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

    // 在所有页面导航前注入 Token
    await context.addInitScript((token) => {
        try { localStorage.setItem('token', `"${token}"`); } catch (e) {}
    }, DISCORD_TOKEN);

    const page = await context.newPage();
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
        await browser.close();
    }

    // 失败时让 Actions 显示红叉，而不是假装成功
    if (failed) process.exit(1);
})();
