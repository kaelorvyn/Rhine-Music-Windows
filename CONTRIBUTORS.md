# 贡献者

Rhine Music（Windows）不是一个人写的。它是三方成果的衍生版，另有若干贡献者在各自的上游仓库里留下了真实提交。本文件是**完整、去重**的名单，逐位列出，不合并成一句「致谢」。

名单来源：GitHub API 的 `contributors` 端点，交叉 `DuoJiuBetter/Rhine-Music-Windows`、`RonaldDeng/Rhine-Music-Demo`、`LBEILC/RhineLabUI`、`kaelorvyn/Rhine-Music-Windows` 四个仓库后去重。同一人在不同仓库的提交数分别标注，**不做跨仓库求和**（衍生仓库通常包含上游历史，求和会重复计算）。

---

## 特别致谢

这三个人的工作构成了本项目的全部基础，缺任何一位都没有现在这个东西。

### [DuoJiuBetter](https://github.com/DuoJiuBetter) — Windows 版维护者

把浏览器里的三维档案界面搬成能双击运行的 Windows 桌面程序：Tauri 桌面壳、运行时打包、安装器、性能优化与平台适配，以及长期的版本维护。本项目的 Windows 形态直接继承自他的工作。

### [RonaldDeng](https://github.com/RonaldDeng) — 原版作者

[Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) V0.4.1 的作者。本地曲库与播放服务、音乐专辑模型、音乐界面、导航、相机交互、文字效果与响应式布局，都出自这里。本项目的播放链路与界面骨架是他的实现。

### [LBEILC（路北路陈）](https://github.com/LBEILC) — 视觉与渲染基础

[RhineLabUI](https://github.com/LBEILC/RhineLabUI) 的作者。三维档案界面、玻璃材质、景深与光照、动效体系、建模脚本与资料说明，是整个视觉语言的来源。本项目的「好看」绝大部分属于他。

---

## 完整名单

| # | 贡献者 | 角色 | 具体贡献 | 仓库（提交数） |
|---|---|---|---|---|
| 1 | [**DuoJiuBetter**](https://github.com/DuoJiuBetter) | Windows 版维护者 | Tauri 桌面壳、运行时打包、安装器、性能与平台适配、长期维护 | `DuoJiuBetter/Rhine-Music-Windows`（维护者） |
| 2 | [**RonaldDeng**](https://github.com/RonaldDeng) | 原版作者 | 本地曲库与播放服务、专辑模型、界面、导航、相机交互、文字效果、响应式 | `Rhine-Music-Demo` 21 · `DuoJiuBetter/Rhine-Music-Windows` 18 |
| 3 | [**LBEILC**（路北路陈）](https://github.com/LBEILC) | 视觉与渲染 | 三维档案界面、玻璃材质、景深光照、动效体系、建模脚本、资料说明 | `RhineLabUI` 105 · `Rhine-Music-Demo` 35 · `DuoJiuBetter/Rhine-Music-Windows` 35 |
| 4 | [**MT-gar**](https://github.com/MT-gar) | 在线源与启动器 | 独立在线专辑架（Internet Archive + Subsonic 兼容自建服务器）、回环代理与逐源主机白名单、许可展示；启动器抗保留端口与陈旧锁 | `Rhine-Music-Demo` 3 · `DuoJiuBetter/Rhine-Music-Windows` 3 |
| 5 | [**rndyt**](https://github.com/rndyt) | 动效 | 细粒度动效控制；首次访问跟随系统动效偏好 | `RhineLabUI` 8 |
| 6 | [**fisHarly0**（Harly）](https://github.com/fisHarly0) | 无障碍与设置 | 弹窗键盘导航纳入链接；设置里自定义音质预设保持可见 | `RhineLabUI` 2 |
| 7 | [**CrKcel**](https://github.com/CrKcel) | 兼容性 | Firefox 音频修复 | `RhineLabUI` 1 |
| 8 | [**EastCation**（辉夜星瞳 / Starmoe）](https://github.com/EastCation) | 输入设备 | 手柄输入处理，查看器帮助文案随输入设备切换 | `RhineLabUI` 1 |
| 9 | [**Woo3aN**](https://github.com/Woo3aN) | 移动端布局 | 弹窗顶栏改 sticky，手机上关闭按钮可操作 | `RhineLabUI` 1 |
| 10 | [**kaelorvyn**](https://github.com/kaelorvyn) | 本仓库维护者 | 0.1.1 起的 Windows 分发与功能：多平台歌单、音质选择、跨源兜底、按键控制、自更新、设置项接入 | `kaelorvyn/Rhine-Music-Windows` 21+ |

## 自动化工具

| 工具 | 说明 |
|---|---|
| [**codex**](https://github.com/codex) | OpenAI 的编码 agent，不是自然人。在上游 `DuoJiuBetter/Rhine-Music-Windows` 留有 1 个提交（0.2.0 预览版发布与安装包下载、模型循环控制）。此处如实记录，不计入贡献者人数，也不替代任何人的署名。 |

## 关于 GitHub 的 Contributors 面板

本仓库的提交历史里并接了三个上游仓库的历史作为祖先 —— `LBEILC/RhineLabUI`、`RonaldDeng/Rhine-Music-Demo`、`DuoJiuBetter/Rhine-Music-Windows`。并接方式是 `git merge -s ours`：**工作树一个文件都没变，已公开的提交也没有被改写**，只是把真实来源记录成祖先关系。这样面板统计的就是真实提交，而不是把别人的代码算到自己头上。

仓库首页的 Contributors 面板现在统计到这 10 位：

| 面板显示 | 提交数 |
|---|---|
| [LBEILC](https://github.com/LBEILC) | 105 |
| [kaelorvyn](https://github.com/kaelorvyn) | 25 |
| [RonaldDeng](https://github.com/RonaldDeng) | 21 |
| [rndyt](https://github.com/rndyt) | 8 |
| [MT-gar](https://github.com/MT-gar) | 3 |
| [fisHarly0](https://github.com/fisHarly0) | 2 |
| [codex](https://github.com/codex) | 1 |
| [CrKcel](https://github.com/CrKcel) | 1 |
| [EastCation](https://github.com/EastCation) | 1 |
| [Woo3aN](https://github.com/Woo3aN) | 1 |

**必须说明的一点：DuoJiuBetter 不在这个面板里。** 原因不是遗漏、也不是名单写错 —— 他在自己的仓库里**没有提交过任何 commit**，全部工作通过发布、打包与版本维护完成，所以任何按提交作者统计的列表都不会出现他。他的维护者身份写在上面「特别致谢」和 [NOTICE.md](NOTICE.md) 的版权行里，那才是他应该在的位置。

同理，这个面板只反映**提交归属**，不衡量贡献大小：一个只提了 1 个提交的人，可能修掉了一个所有人都没发现的 bug。

---

## 署名要求

- 上面每一位的署名都属于他们本人，本仓库的维护者署名**不取代**上游署名。
- 分发本代码或其重要部分时，须一并保留 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md) 中的版权声明。
- 名单按**作用**排列，不按提交量排名 —— 提交数量取决于各人分工，与贡献价值无关。
- 若发现遗漏或错记，请在 [Issues](https://github.com/kaelorvyn/Rhine-Music-Windows/issues) 指出，会按证据更正。

许可与第三方素材的权利边界见 [NOTICE.md](NOTICE.md) 与 [PLATFORM-NOTICE.md](PLATFORM-NOTICE.md)。
