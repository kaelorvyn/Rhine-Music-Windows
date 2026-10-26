# Rhine Music · Windows

把本地音乐放进三维玻璃专辑架里浏览和播放的音乐播放器，Windows 桌面版。

这是 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) V0.4.1 的 **Windows 社区衍生版**，视觉与渲染基础来自 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)。Windows 形态的移植与长期维护者：[DuoJiuBetter](https://github.com/DuoJiuBetter)；本仓库（**0.1.1** 起）由 [kaelorvyn](https://github.com/kaelorvyn) 维护并发布。完整贡献者名单见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

本仓库与上游作者、各音乐平台及原作品牌方**没有官方合作关系**。

---

## 这个版本是什么

**0.1.1**，Windows x64，Tauri + WebView2 桌面程序。

它能在真实曲库上跑起来、能放歌。下面每一条都写了验证到什么程度，没验证的我直接说没验证。

### 能用的功能

| 功能 | 状态 |
|---|---|
| 本地音乐库扫描与三维专辑架浏览 | 可用 |
| 播放本地文件（MP3 / FLAC / WAV / AAC 等 WebView2 原生可解码格式） | 可用 |
| 登录网易云 / QQ / 酷狗 / 酷我 / 波点 / JOOX 并搜索其曲库 | 可用，各平台授权情况不同 |
| 在线歌曲取源播放 | 可用，取决于平台授权与账号权限 |
| 歌单（本地歌单 + 平台歌单） | 可用 |
| 歌词滚动与点击定位 | 可用 |
| 下载 | 可用，按每首歌实际提供的音质档位选择下载 |
| 音质档位选择 | 可用，实时列出标准 / 高品 / 无损 / Hi-Res / HiFi / 环绕 / 母带各档及其真实体积 |
| 缓存管理 | 可用，上限、位置、清理均可调 |
| 主题切换 | 可用，米色 / 深蓝 / 蓝灰 |
| 3D 场景画质调节（含独显增强） | 可用，帧率取决于显卡 |

在线歌曲会依次尝试多个音源，拿到可播放地址即用，不再继续尝试。

## 本版修了什么

### 1. 有些歌只能放 60 秒

**现象**：某首歌在 A 平台只有 60 秒试听，但同一首歌在 B、C 平台明明有全曲，程序却没有去取。

**原因**：各平台返回的曲目标题格式不统一 —— 有的只给歌名，有的把歌手名前缀、甚至尾缀也塞在标题里。程序按标题判断「是不是同一首歌」，格式对不上就判定为不同歌，于是可用的全曲被漏掉。

**修法**：比对前先把标题里多余的歌手名去掉，只留歌名本身。同时要求去掉的那段确实是歌手名，避免把歌名里本来就有的连字符（如 A-Lin）误切。

顺带调整了音源优先顺序：优先能整首放完的，其次才比音质。付费歌常只给试听片段，能完整听完比音质高更重要。

### 2. 换源时画面闪一下

**现象**：播放中后台换了音源，3D 专辑架会翻到另一张封面闪一下。

**原因**：换源时把队列里那一条整个替换掉了，连带的封面、专辑信息也跟着变，画面于是重建。

**修法**：换源只更换实际播放的地址，界面上的封面、标题、专辑都保持原样。现在换源是静默的，你想切过去可以自己点。

额外好处：因为是「同一首歌」在换源，**播放进度不会丢**，不会从头开始。

### 3. 取源慢

**现象**：遇到放不出来的歌，要等十几秒才报错。

**修法**：给每个音源都设了更短的超时，某一环没结果就快速跳过。现在最坏情况从 13 秒降到 5 秒以内，能放的歌不受影响。

同一首歌短时间内重复点，会直接沿用上次结果，不再重新走一遍。

---

## 已知问题

这些是**真实存在、没有解决**的问题：

1. **酷我 QMC 母带加密格式解不开。** 遇到会回落到明文无损，音质有损。无损下载不受影响（酷我无损是明文 FLAC）。
2. **部分备用来源当前不可用。** 程序会快速跳过它们，不影响能正常播放的歌。
3. **付费歌曲受平台限制。** 平台只给试听片段时，程序会尝试跨源找全曲；找不到就播试听。这是版权边界，不是 bug。
4. **帧率未做多机型验证。** 本机（2K、独显增强档）测得 166fps，但只有这一个数据点，不代表你的机器。
5. **两个包都没做代码签名。** Windows 可能弹 Smartscreen 警告。
6. **未捆绑 FFmpeg。** APE、部分 DSD 等格式需自行安装 ffmpeg/ffprobe，或用 `FFMPEG_PATH`、`FFPROBE_PATH` 指定路径。

---

## 下载与使用

从 [Releases](https://github.com/kaelorvyn/Rhine-Music-Windows/releases) 下载：

| 形态 | 文件 | 说明 |
|---|---|---|
| **便携版** | `...-portable.zip` | 解压后双击 `Rhine Music.exe`。**必须保留整个 `runtime` 目录**，不能只拿 exe。 |
| **安装版** | `...-setup.exe` | NSIS 安装到用户目录（`%LOCALAPPDATA%`），**不需要管理员权限**。 |

两个版本功能相同。程序自带 Node.js 运行时，不需要另装 Node.js、npm 或 Rust。

**系统要求**：Windows 10 / 11 x64，需要 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带；Win10 缺失时安装版会引导下载）。

### 数据放哪

```
%LOCALAPPDATA%\local.rhine.music.windows\music-data\
```

包含配置、曲库索引、歌单、各平台登录会话（用 Windows DPAPI 分平台加密保存）等。

音乐文件本身**只读**，程序不会修改你的文件。

### 本地音乐怎么加

设置 → 本地歌单设置 → 添加目录，程序会扫描并建立索引。

---

## 从源码构建

需要：Windows x64、Node.js ≥ 22.12.0、Rust stable、Visual Studio C++ 构建工具、Windows SDK。

```powershell
npm ci
npm run desktop:prepare                                # 准备网页与运行时
npx tauri build --no-bundle -- --locked                # 编译 exe
node scripts/package-desktop.mjs                       # 组便携包
```

安装版去掉 `--no-bundle`（需要 NSIS）。

---

## 验证情况

**做了：** 类型检查通过、生产构建通过、核心逻辑带单元测试。

**没做：** 多显卡/多分辨率帧率测试、长时间的播放稳定性测试、所有平台的付费与版权边界覆盖。

---

## 许可与致谢

有权授权的程序代码、脚本和技术文档采用 [MIT License](LICENSE)。

### 作者与贡献者

这个项目不是一个人写的。代码和设计来自三方，另有若干贡献者在各自的上游仓库里留下了真实提交。**完整名单见 [CONTRIBUTORS.md](CONTRIBUTORS.md)**（10 人，去重，逐位列出）。

先向这三个人特别致谢 —— 缺任何一位都没有现在这个东西：

| | 作者 | 贡献 |
|---|---|---|
| **Windows 版维护者** | [**DuoJiuBetter**](https://github.com/DuoJiuBetter) | 把三维档案界面搬成能双击运行的 Windows 程序：Tauri 桌面壳、运行时打包、安装器、性能优化、平台适配与长期维护 |
| **原版作者** | [**RonaldDeng**](https://github.com/RonaldDeng) | [Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) V0.4.1 的完整实现：本地曲库与播放服务、专辑模型、音乐界面、导航、相机交互、文字效果、响应式 |
| **视觉与渲染基础** | [**LBEILC**（路北路陈）](https://github.com/LBEILC) | [RhineLabUI](https://github.com/LBEILC/RhineLabUI) 的三维视觉、玻璃材质、景深与光照、动效体系、建模脚本 |

其余贡献者（在线源与启动器、动效、无障碍、兼容性、手柄输入、移动端布局、本仓库维护）：

| # | 贡献者 | 贡献 |
|---|---|---|
| 4 | [**MT-gar**](https://github.com/MT-gar) | 独立在线专辑架（Internet Archive + Subsonic 兼容自建服务器）、回环代理与逐源主机白名单、启动器抗保留端口与陈旧锁 |
| 5 | [**rndyt**](https://github.com/rndyt) | 细粒度动效控制；首次访问跟随系统动效偏好 |
| 6 | [**fisHarly0**（Harly）](https://github.com/fisHarly0) | 弹窗键盘导航纳入链接；自定义音质预设保持可见 |
| 7 | [**CrKcel**](https://github.com/CrKcel) | Firefox 音频修复 |
| 8 | [**EastCation**（辉夜星瞳）](https://github.com/EastCation) | 手柄输入处理，查看器帮助文案随输入设备切换 |
| 9 | [**Woo3aN**](https://github.com/Woo3aN) | 弹窗顶栏改 sticky，手机上关闭按钮可操作 |
| 10 | [**kaelorvyn**](https://github.com/kaelorvyn) | 本仓库维护者：0.1.1 起的 Windows 分发与功能（多平台歌单、音质选择、跨源兜底、按键控制、自更新） |

上游 `DuoJiuBetter/Rhine-Music-Windows` 另有 1 个提交由 OpenAI 的编码 agent **codex** 完成（0.2.0 预览版发布）。它**不是自然人**，不计入贡献者人数，但在 [CONTRIBUTORS.md](CONTRIBUTORS.md) 里如实记录。

名单按**作用**排列，不按提交量排名。每一位的署名属于他们本人，本仓库的维护者署名不取代上游署名；MIT 许可要求保留原作者署名，这里逐位列出，不只写一个「致谢」。

MiSans 字体、第三方依赖、模型、标志、《明日方舟》相关视觉元素及声音采样各自遵循其权利边界，不能一概视为 MIT 或已获商业授权。详见 [NOTICE.md](NOTICE.md) 与 [PLATFORM-NOTICE.md](PLATFORM-NOTICE.md)。

**平台边界**：各平台适配均为非官方实现，未获任何平台授权。根据各平台用户服务协议，未经授权通过第三方工具接入其服务可能构成违约。是否使用、如何使用由你自行判断并承担风险。详见 [PLATFORM-NOTICE.md](PLATFORM-NOTICE.md)。

隐私说明见 [PRIVACY.md](PRIVACY.md)。


源码完整公开，包括取源链路、各平台适配与 `scripts/lx-sources/` 下的第三方音源。唯一不入库的是用户导入的密钥文件（`*.rhinekey`、`pool-credential.json`、`build-credential.json`）。

共享音源的服务地址不在代码里写死，一律由用户导入的密钥提供；未导入密钥时该通道停用，其余功能不受影响。
