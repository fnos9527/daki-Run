const { chromium } = require('playwright');
const axios = require('axios'); [cite: 4]
const FormData = require('form-data'); [cite: 4]
const fs = require('fs'); [cite: 4]

// Telegram 通知函数 [cite: 5]
async function sendTelegram(token, chatId, message, photoPath) {
    const url = `https://api.telegram.org/bot${token}/sendPhoto`; [cite: 5]
    const form = new FormData(); [cite: 5]
    form.append('chat_id', chatId); [cite: 6]
    form.append('caption', message); [cite: 6]
    if (fs.existsSync(photoPath)) { [cite: 6]
        form.append('photo', fs.createReadStream(photoPath)); [cite: 6]
    }
    try {
        await axios.post(url, form, { headers: form.getHeaders() }); [cite: 7]
        console.log('通知已发送至 Telegram'); [cite: 8]
    } catch (e) {
        console.error('发送 TG 失败:', e.message); [cite: 8]
    }
}

(async () => {
    // 启动浏览器
    const browser = await chromium.launch({ headless: true }); [cite: 9]
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }, [cite: 9]
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' [cite: 9]
    });

    const DISCORD_TOKEN = process.env.DISCORD_TOKEN; [cite: 9]

    // 核心逻辑：在所有页面导航前注入 Token 
    // 注意：Discord 的 localStorage token 必须包含双引号，例如 "MTIzNDU2..."
    await context.addInitScript((token) => {
        localStorage.setItem('token', `"${token}"`);
    }, DISCORD_TOKEN);

    const page = await context.newPage(); [cite: 9]

    try {
        console.log('正在访问 Daki...');
        await page.goto('https://dash.daki.cc', { waitUntil: 'networkidle' }); [cite: 10]
        
        console.log('点击 Discord 登录...');
        await page.waitForSelector('button:has-text("Discord"), a:has-text("Discord")'); [cite: 10]
        await page.click('button:has-text("Discord"), a:has-text("Discord")'); [cite: 10]
        
        // 等待进入 Discord 授权页并处理授权
        console.log('检查 Discord 授权状态...');
        try {
            // 增加对授权按钮的动态等待，避免固定等待 8 秒导致的超时 [cite: 10, 13]
            const authButton = page.locator('button:has-text("Authorize"), button:has-text("授权")');
            await authButton.waitFor({ state: 'visible', timeout: 30000 }); [cite: 13]

            // 检查是否需要先滚动（处理 Discord 的 "Keep Scrolling" 逻辑） [cite: 11]
            const scrollBtn = page.locator('button:has-text("Keep Scrolling")'); [cite: 11]
            if (await scrollBtn.isVisible()) { [cite: 12]
                console.log('发现滚动按钮，正在向下滚动...');
                await scrollBtn.click(); [cite: 12]
                await page.waitForTimeout(1000); [cite: 12]
            }

            console.log('点击授权按钮...');
            await authButton.click(); [cite: 14]
        } catch (e) {
            console.log('未检测到授权按钮，可能已通过 Token 自动登录或页面已跳转。');
        }

        // 等待授权完成后跳转回 Daki
        await page.waitForURL('**/dash.daki.cc/**', { timeout: 60000 });

        console.log('进入服务器列表...');
        await page.goto('https://dash.daki.cc/servers', { waitUntil: 'networkidle', timeout: 60000 }); [cite: 15, 16]
        
        console.log('寻找续期按钮...');
        const renewBtn = page.locator('button:has-text("Renew"), .btn-success:has-text("Renew")'); [cite: 16]
        await renewBtn.waitFor({ state: 'visible', timeout: 30000 }); [cite: 17]
        await renewBtn.click(); [cite: 17]
        await page.waitForTimeout(3000); [cite: 17]

        console.log('处理确认弹窗...');
        await page.locator('input[type="checkbox"]').first().check(); [cite: 17]
        await page.click('button:has-text("Continue")'); [cite: 17]

        console.log('进入倒计时页面，等待 185 秒...');
        await page.waitForTimeout(185000); [cite: 18]

        console.log('尝试点击领取...');
        const claimButton = page.locator('button:has-text("领取"), button:has-text("Claim"), .btn-primary:has-text("3")'); [cite: 18]
        await claimButton.click(); [cite: 18]
        
        console.log('等待最终结果...');
        await page.waitForTimeout(15000); [cite: 18]
        await page.screenshot({ path: 'result.png', fullPage: true }); [cite: 19]

        await sendTelegram( [cite: 19]
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            '✅ Daki 自动续期任务执行完毕！',
            'result.png'
        );
    } catch (err) { [cite: 20]
        console.error('运行出错:', err); [cite: 20]
        await page.screenshot({ path: 'error.png' }); [cite: 20]
        await sendTelegram( [cite: 21]
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID,
            `❌ Daki 续期失败: ${err.message}`,
            'error.png'
        );
    } finally { [cite: 22]
        await browser.close(); [cite: 22]
    }
})();
