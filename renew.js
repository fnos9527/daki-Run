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
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // 核心修复：预注入 Token 脚本，确保 localStorage 可用
    const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
    await context.addInitScript((token) => {
        window.addEventListener('beforeunload', () => {
            localStorage.setItem('token', `"${token}"`);
        });
        localStorage.setItem('token', `"${token}"`);
    }, DISCORD_TOKEN);

    const page = await context.newPage();

    try {
        console.log('正在登录 Discord 以同步状态...');
        await page.goto('https://discord.com/login');
        await page.waitForTimeout(5000);

        console.log('正在访问 Daki 仪表盘...');
        await page.goto('https://dash.daki.cc');
        
        // 点击登录按钮
        const discordLoginBtn = page.locator('button:has-text("Discord"), a:has-text("Discord")');
        await discordLoginBtn.click();
        
        console.log('等待授权确认...');
        await page.waitForTimeout(10000);
        
        // 尝试自动点击 Discord 的“授权”按钮（如果弹出）
        const authButton = page.locator('button:has-text("Authorize"), button:has-text("授权")');
        if (await authButton.isVisible()) {
            await authButton.click();
            await page.waitForTimeout(5000);
        }

        console.log('进入服务器列表...');
        await page.goto('https://dash.daki.cc/servers', { waitUntil: 'networkidle' });
        
        console.log('寻找续期按钮...');
        const renewBtn = page.locator('button:has-text("Renew"), .btn-success:has-text("Renew")');
        await renewBtn.click();
        await page.waitForTimeout(3000);

        console.log('勾选协议并继续...');
        // 对应图四：找到那个复选框打勾
        await page.locator('input[type="checkbox"]').first().check();
        await page.click('button:has-text("Continue")');

        console.log('进入倒计时页面，等待 3 分钟 (185s)...');
        // 等待 185 秒
        await page.waitForTimeout(185000); 

        console.log('倒计时结束，尝试点击领取...');
        const claimButton = page.locator('button:has-text("领取"), button:has-text("Claim")');
        await claimButton.click();
        
        console.log('操作完成，等待页面跳转...');
        await page.waitForTimeout(10000);

        await page.screenshot({ path: 'result.png', fullPage: true });
        await sendTelegram(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            '✅ Daki 自动续期任务执行完毕！\n请检查截图确认状态。',
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
