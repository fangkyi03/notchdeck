# NotchDeck 宣传文案

链接：https://github.com/fangkyi03/notchdeck ｜ 官网 https://fangkyi03.github.io/notchdeck/

---

## V2EX（节点：分享创造）

**标题**：做了个 Mac / Windows 通用的开源桌面灵动岛，能看 Claude Code / Codex / Cursor 剩余额度

用 AI 写代码以后最常干的事是去网页上看额度还剩多少，于是做了 NotchDeck：一个常驻屏幕顶部的灵动岛，鼠标移上去展开。

- AI 额度：Claude Code、Codex、Cursor、DeepSeek、OpenRouter、Kimi、GLM，也支持自定义命令 / HTTP
- 音乐与歌词、系统监控（CPU/内存/网速/电池）、消息未读提醒
- 待办 + 日历（iCloud / CalDAV / ICS）、番茄钟、喝水提醒
- 剪贴板历史（含图片）、文件中转架、快捷翻译
- 可拖到任意屏幕、贴边变竖向，有多套皮肤和指示条形态
- Tauri 写的，安装包十几 MB，macOS（Intel / Apple Silicon）和 Windows 都有

下载：https://github.com/fangkyi03/notchdeck/releases
欢迎提 issue，Windows 端尤其需要反馈。

---

## 少数派 / 掘金（长文提纲）

1. 为什么想要一个跨平台灵动岛（刘海屏之外的 Mac、Windows 都没有）
2. 核心场景：AI 编程额度一眼可见（截图 page-ai.png）
3. 日常功能逐个过：音乐、监控、待办日历、剪贴板、文件中转（各配截图）
4. 自定义：皮肤、页面开关、快捷键、贴边停靠
5. 技术实现简述：Tauri 2 + React，两个平台分别调用系统 API
6. 下载与反馈

---

## Reddit（r/macapps，r/Windows 或 r/software，r/ClaudeAI）

**Title**: I made a free, open-source Dynamic Island for macOS and Windows that shows your Claude Code / Codex / Cursor quota

NotchDeck sits at the top of your screen and expands on hover:

- AI coding quota: Claude Code, Codex, Cursor, OpenRouter, DeepSeek, plus custom command/HTTP sources
- Now playing + lyrics, system monitor, unread message badges
- Todo + calendar (iCloud/CalDAV/ICS), focus timer, water reminder
- Clipboard history (with images), file shelf, quick translate
- Works on any monitor, docks to the sides vertically, multiple skins

It's built with Tauri, so the installer is small. Downloads for Apple Silicon, Intel and Windows:
https://github.com/fangkyi03/notchdeck/releases

The UI is Chinese-first right now. Feedback is welcome, especially from Windows users.

> 注意：r/macapps 等版块要求自己发的帖子有标注，且禁止频繁自推。发帖前先看各版块规则。另外英文用户会卡在中文界面上，做了英文版以后再发 Reddit 和 HN 效果会好很多。

---

## Hacker News（Show HN）

**Title**: Show HN: NotchDeck – open-source Dynamic Island for macOS and Windows (Tauri)

**Text**: 和 Reddit 版内容相同，但要再短一些。多写技术细节：屏幕保护程序级别的窗口、跨不同缩放比例的多显示器坐标、分平台实现。

---

## 其他渠道

- **awesome 列表 PR**：jaywcjlove/awesome-mac、serhii-londar/open-source-mac-os-apps、tauri-apps/awesome-tauri。每个仓库的格式要求不同，提交前先看它的 CONTRIBUTING。
- **Product Hunt**：需要英文界面、logo 和 3 到 5 张图。
- **即刻 / 小红书 / B 站**：录一段 30 秒的屏幕视频，比截图效果好。
- **Google 收录**：在 Search Console 添加站点 https://fangkyi03.github.io/notchdeck/ 并提交 sitemap.xml。
