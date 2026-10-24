# 电视键盘（webOS TV Keyboard）

用手机或电脑的浏览器，往 LG webOS 电视上的输入框打字。不需要 root，中文直接输入。

电视上打开「电视键盘」会显示一个二维码。手机扫码（或电脑打开对应地址）后得到一个输入页：
打的字会同步进电视当前 App 里选中的输入框，点「发送 / 搜索」相当于回车。地址固定，加到主屏幕后以后不用再扫。

## 支持范围

| 应用 | 支持 |
|---|---|
| 开发者模式侧载的网页应用（Moonfin、海外哔哩、BiliTV、Clean Your TV 启动器等） | ✅ |
| LG 商店应用（YouTube、Netflix、官方 Emby…）、LG 系统应用 | ❌ |

## 为什么只能支持侧载应用

webOS 有一组系统输入法接口（`com.webos.service.ime/insertText`、`deleteCharacters`、`sendEnterKey`、`registerRemoteKeyboard`），LG ThinQ 手机 App 的键盘就是靠它们。在 webOS 25 上实测：

- 通过遥控接口（SSAP，`wss://<电视>:3001`）调用：方法存在，但对未经 LG 签名的客户端请求一直挂起不回。开源社区通用的签名清单已被固件拉黑。
- 在电视上的服务里直接走 Luna 总线调用：这几个方法只属于 `private`、`devices` 两个 ACG 组，开发者模式应用只能申请 `public` 一类的组，调用被拒绝（`Denied method call`）。

可行的路是开发者模式自带的远程调试入口：电视本机 `127.0.0.1:9998` 上能列出所有侧载网页应用的 DevTools 页面。服务用 SSAP 查到前台应用，连上它的 DevTools 会话，用 `Input.insertText` 把文字插进当前输入框（和输入法提交文字等效，页面收到正常的 input 事件），退格和回车用 `Input.dispatchKeyEvent`。商店应用和系统应用不开放调试，所以不支持。

## 组成

```text
app/       电视端 App：二维码、地址、连接状态
service/   电视端 JS 服务（常驻，开机后由定时 activity 拉起）
  server.js   局域网 HTTP 服务（7788 端口），带 token 校验，SSE 推送当前应用状态
  inject.js   找到前台应用的 DevTools 页面，插入文字 / 退格 / 回车
  ssap.js     连电视自己的遥控接口，只用来查询前台应用
  page.html   手机/电脑上的输入页
  qrcode.js   qrcode-generator（MIT，Kazuhiko Arase）
tests/     node --test
```

安全：输入页和接口都要带二维码里的随机 token；局域网里的其他设备拿不到 token 就无法打字。token 存在服务目录里，重新安装会更换。

## 安装

需要 LG 开发者模式和 webOS CLI（`npm i -g @webos-tools/cli`）。

```sh
ares-package app service -o dist
ares-install -d <设备名> dist/com.lfkdsk.tvkeyboard_1.0.0_all.ipk
ares-launch -d <设备名> com.lfkdsk.tvkeyboard
```

第一次启动时服务会和电视配对；如果电视弹出「允许连接」提示，选允许。

## 已知限制

- 只支持侧载的网页应用（见上）。
- 电视同时连着网线和 Wi‑Fi 时，地址用网线的 IP。
- 服务被系统回收后，最长 15 分钟内由定时 activity 拉起；打开一次「电视键盘」App 会立刻拉起。
- 开发者模式到期会删除所有侧载应用，包括本应用。

MIT License.
