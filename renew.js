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
    // 启动浏览器
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        console.log('正在注入 Discord Token...');
        await page.goto('https://discord.com/login');
        await page.evaluate((token) => {
            localStorage.setItem('token', `"${token}"`);
        }, process.env.DISCORD_TOKEN);
        await page.waitForTimeout(3000);

        console.log('访问 Daki 登录页...');
        await page.goto('https://dash.daki.cc');
        await page.click('button:has-text("Discord")');
        
        // 等待授权页面并点击
        console.log('等待 Discord 授权...');
        await page.waitForTimeout(10000);
        const authButton = page.locator('button:has-text("Authorize"), button:has-text("授权")');
        if (await authButton.isVisible()) {
            await authButton.click();
        }

        console.log('进入服务器列表...');
        await page.goto('https://dash.daki.cc/servers', { waitUntil: 'networkidle' });
        
        console.log('点击 Renew 按钮...');
        await page.click('button:has-text("Renew"), .btn-success:has-text("Renew")');
        await page.waitForTimeout(2000);

        console.log('勾选确认框并继续...');
        // 对应图四：勾选复选框并点击 Continue
        await page.locator('input[type="checkbox"]').check();
        await page.click('button:has-text("Continue")');

        console.log('进入广告页，开始 3 分钟超长等待 (185s)...');
        // 修改点 1：增加等待时间至 185 秒
        await page.waitForTimeout(185000); 

        console.log('尝试点击领取 +3 天...');
        const claimButton = page.locator('button:has-text("领取"), button:has-text("Claim")');
        await claimButton.click();
        
        // 等待页面跳转回服务器列表，确认续期成功
        await page.waitForTimeout(10000);
        console.log('流程结束，正在截图...');
        await page.screenshot({ path: 'result.png', fullPage: true });

        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            '✅ Daki 自动续期成功！\n下次续期将在 3 天后。',
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
