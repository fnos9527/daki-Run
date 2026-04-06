const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

async function sendTelegram(token, chatId, message, photoPath) {
    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', message);
    if (fs.existsSync(photoPath)) {
        form.append('photo', fs.createReadStream(photoPath));
    }
    try {
        await axios.post(url, form, { headers: form.getHeaders() });
        console.log('通知已发送至 Telegram');
    } catch (e) {
        console.error('发送 TG 失败:', e.message);
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
    await context.addInitScript((token) => {
        window.localStorage.setItem('token', `"${token}"`);
    }, DISCORD_TOKEN);

    const page = await context.newPage();

    try {
        console.log('正在访问 Daki...');
        await page.goto('https://dash.daki.cc', { waitUntil: 'networkidle' });
        
        console.log('点击 Discord 登录...');
        await page.click('button:has-text("Discord"), a:has-text("Discord")');
        
        // 等待进入 Discord 授权页
        await page.waitForTimeout(8000);

        // --- 核心修复：处理 Discord 授权弹窗 ---
        console.log('检查 Discord 授权按钮...');
        // 有时候按钮需要滚动到底部才出现
        const scrollBtn = page.locator('button:has-text("Keep Scrolling"), .lookFilled-1H2q2S');
        if (await scrollBtn.isVisible()) {
            console.log('发现滚动按钮，正在向下滚动...');
            await scrollBtn.click();
            await page.waitForTimeout(1000);
        }

        const authButton = page.locator('button:has-text("Authorize"), button:has-text("授权")');
        if (await authButton.isVisible()) {
            console.log('点击授权按钮...');
            await authButton.click();
            await page.waitForTimeout(8000);
        }
        // ------------------------------------

        console.log('进入服务器列表...');
        await page.goto('https://dash.daki.cc/servers', { waitUntil: 'networkidle', timeout: 60000 });
        
        console.log('寻找续期按钮...');
        const renewBtn = page.locator('button:has-text("Renew"), .btn-success:has-text("Renew")');
        await renewBtn.waitFor({ state: 'visible', timeout: 30000 });
        await renewBtn.click();
        await page.waitForTimeout(3000);

        console.log('处理确认弹窗...');
        await page.locator('input[type="checkbox"]').first().check();
        await page.click('button:has-text("Continue")');

        console.log('进入倒计时页面，等待 185 秒...');
        await page.waitForTimeout(185000); 

        console.log('尝试点击领取...');
        const claimButton = page.locator('button:has-text("领取"), button:has-text("Claim"), .btn-primary:has-text("3")');
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
        console.error('运行出错:', err);
        await page.screenshot({ path: 'error.png' });
        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            `❌ Daki 续期失败: ${err.message}`,
            'error.png'
        );
    } finally {
        await browser.close();
    }
})();
