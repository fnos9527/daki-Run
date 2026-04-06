const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

async function sendTelegram(token, chatId, message, photoPath) {
    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', message);
    form.append('photo', fs.createReadStream(photoPath));
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
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    try {
        console.log('正在设置 Discord 授权状态...');
        // 访问 discord 域名以注入 Token
        await page.goto('https://discord.com/login');
        await page.evaluate((token) => {
            setInterval(() => {
                document.body.appendChild(document.createElement(`iframe`)).contentWindow.localStorage.token = `"${token}"`;
            }, 50);
            setTimeout(() => { location.reload(); }, 2500);
        }, process.env.DISCORD_TOKEN);
        await page.waitForTimeout(5000);

        console.log('正在打开 Daki 登录页...');
        await page.goto('https://dash.daki.cc');
        
        // 点击使用 Discord 登录
        await page.click('button:has-text("Discord")');
        await page.waitForTimeout(8000);

        // 如果跳转到 Discord 授权页，点击“授权”按钮
        const authButton = page.locator('button:has-text("Authorize"), button:has-text("授权")');
        if (await authButton.isVisible()) {
            await authButton.click();
            await page.waitForTimeout(5000);
        }

        console.log('进入仪表盘，点击 Servers...');
        await page.goto('https://dash.daki.cc/servers');
        await page.waitForTimeout(3000);

        console.log('查找续期按钮...');
        await page.click('button:has-text("Renew"), .btn-success:has-text("Renew")');
        await page.waitForTimeout(2000);

        console.log('处理确认弹窗...');
        // 勾选协议并点击 Continue
        await page.locator('input[type="checkbox"]').check();
        await page.click('button:has-text("Continue")');

        console.log('到达广告页面，等待倒计时 (125秒)...');
        // 这里根据你的图片，等待约2分钟
        await page.waitForTimeout(125000); 

        console.log('点击领取按钮...');
        const claimButton = page.locator('button:has-text("Claim"), button:has-text("领取")');
        await claimButton.click();
        await page.waitForTimeout(5000);

        console.log('续期完成，正在截图...');
        await page.screenshot({ path: 'result.png', fullPage: true });

        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            '✅ Daki 服务器自动续期成功！',
            'result.png'
        );

    } catch (err) {
        console.error('流程出错:', err);
        await page.screenshot({ path: 'error.png' });
        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            `❌ 续期失败: ${err.message}`,
            'error.png'
        );
    } finally {
        await browser.close();
    }
})();
