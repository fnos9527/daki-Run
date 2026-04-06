# daki-Run

你的 GitHub 仓库中，点击 Settings -> Secrets and variables -> Actions，添加以下 Repository secrets:

DISCORD_TOKEN: 你的 Discord 账号 Token。

TELEGRAM_BOT_TOKEN: 你的 TG 机器人 Token。

TELEGRAM_CHAT_ID: 你的 TG 账号 ID。


DISCORD_TOKEN获得访问 Discord 官网 并登录你的账号打开开发者工具 (F12)
点击 Console（控制台）选项卡，粘贴并运行以下代码，它会直接弹窗显示你的 Token

---

window.webpackChunkdiscord_app.push([
  [Math.random()],
  {},
  req => {
    for (const m of Object.keys(req.c)
      .map(x => req.c[x].exports)
      .filter(x => x)) {
      if (m.default && m.default.getToken !== undefined) {
        return console.log("%c你的 Token 是: %c" + m.default.getToken(), "color:white;font-size:18px;", "color:red;font-size:18px;font-weight:bold;");
      }
      if (m.getToken !== undefined) {
        return console.log("%c你的 Token 是: %c" + m.getToken(), "color:white;font-size:18px;", "color:red;font-size:18px;font-weight:bold;");
      }
    }
  }
]);
