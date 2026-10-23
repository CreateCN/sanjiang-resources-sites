# 图片来源、许可与资料核对记录

核对与采集日期：2026-10-20。本站是面向三江学院学生的独立学习资源目录，不代表三江学院或各资源提供方的授权、采购、认证、合作或背书。

## 使用边界

以下均为真实官方产品截图或官方网页截图，不是生成图片，也不是我们在校园账户下运行软件的实测截图。保留原图，不改写界面内容；网页展示时可以等比缩放或裁切。图片内的名称、商标、示例作品和第三方材料仍归对应权利人所有，软件的开源许可证不自动适用于官网图片。

对未找到独立图片开放许可证的截图，以下明确标记为“网络图片，来源与再分发许可未确认”，仅用于本非商业学习目录的产品介绍、识别与界面引用，不声称已经取得额外授权，也不将其纳入本站代码许可证。页面会显示“网络图片，来源与授权未确认；如有侵权请联系管理员处理”，并提供“版权与下架”入口。

**默认发行边界**：默认 Docker/生产构建只分发许可明确的 `gimp.png` 与 `libreoffice-interface.png`。以下三张“来源与再分发许可未确认”的旧截图及全部 WebP 派生图**不进入默认产物**，但原图仍保留在工作区并记录于此：

- `zotero-interface.png`
- `obs-interface.png`
- `vlc-interface.jpg`

旧实例如仍引用这些 URL，需要部署者确认权利后显式构建兼容素材（`INCLUDE_LEGACY_ASSETS=1`），或通过后台替换为许可明确的素材。默认构建遇到这些引用时使用“图片已下架或不可用”占位，不输出指向缺失文件的 `img`/`srcset`。兼容包不自动下载，也不改变旧数据库字段；旧备份只保证 DB+媒体对象，不包含这些构建期静态图片。

**下架处理**：权利人可通过反馈页的“版权与下架”提交页面地址与权利依据；核实后我们会移除或替换图片，保留官方链接，并在此文件记录处理结果。该流程用于降低侵权风险，不构成授权声明，也不能替代取得许可。

## 本地图片

### Zotero 文献库截图

- 文件：[zotero-interface.png](./zotero-interface.png)
- 来源页面：[Zotero 官网](https://www.zotero.org/)
- 原图：[官网文献库截图](https://www.zotero.org/static/images/home/screenshot-7.0.png)
- 权利归属：Zotero / Digital Scholar 及截图内相应内容权利人。
- 许可记录：网络图片，来源与再分发许可未确认；不将 Zotero 源码的 GNU AGPL 第三版冒充图片许可。页面已标注“网络图片”，侵权请联系管理员下架。
- 用途：帮助识别文献库、条目列表与元数据面板；原样下载，未进行内容编辑，不暗示官方支持本目录。

### LibreOffice Writer 中文界面

- 文件：[libreoffice-interface.png](./libreoffice-interface.png)
- 来源页面：[LibreOffice 简体中文官网软件截图](https://zh-cn.libreoffice.org/discover/page-826/)
- 原图：[Writer 主界面及侧边栏](https://zh-cn.libreoffice.org/assets/Uploads/zh-cn/screenshots/writer/writer-main-sidebar.png)
- 作者及归属：The Document Foundation / LibreOffice 简体中文社区；软件与商标归相应权利人。
- 许可：[知识共享署名—相同方式共享第三版](https://creativecommons.org/licenses/by-sa/3.0/)。已核对来源页页脚“除另有说明，本站文本与图片采用该许可”的声明。软件源码采用的 Mozilla 公共许可证与该图片许可不同；商标不因图片许可而放弃。
- 用途：介绍课程报告写作界面。原样下载，无内容修改；如制作衍生图片，应保留署名、许可链接并采用相同方式共享。

### GIMP 官方网站界面截图

- 文件：[gimp.png](./gimp.png)
- 来源：[GIMP 官方网站首页](https://www.gimp.org/)
- 采集：本次使用本机 Chrome 无头模式，1440 × 1000 视口，2026-10-20 截取官方网页；非 GIMP 软件运行实测。
- 作者及归属：GIMP's Team；顶部作品《Matador Rocks》作者 Mica Semrick，网站注明[作品来源](https://silentumbrella.com/)；其他元素归对应权利人。
- 许可：官网页脚声明网站默认采用[知识共享署名—相同方式共享第四版](https://creativecommons.org/licenses/by-sa/4.0/)，顶部作品也标注该许可；字体图标为[署名第四版](https://creativecommons.org/licenses/by/4.0/)。商标与其他另有声明元素保留原权利。
- 用途：引用官方产品介绍与下载入口，不以背景图片作为无关装饰。与官网原文相比仅截取视口，无界面内容修改；本截图依对应共享许可提供。

### OBS Studio 官方演示界面

- 文件：[obs-interface.png](./obs-interface.png)
- 来源页面：[OBS Studio 官网](https://obsproject.com/)
- 原图：[官网演示界面](https://obsproject.com/assets/images/features-new/hero_32_1_1.png)
- 权利归属：OBS Project / Wizards of OBS LLC，以及演示画面中的相应权利人。
- 许可记录：网络图片，来源与再分发许可未确认；官网页脚保留所有权利。软件 GNU GPL 第二版不自动适用于官网演示画面和第三方游戏内容。页面已标注“网络图片”，侵权请联系管理员下架。
- 用途：仅作产品界面识别与录屏工具介绍的截图引用，原样下载，不声称获得额外授权。

### VLC 官方桌面截图

- 文件：[vlc-interface.jpg](./vlc-interface.jpg)
- 来源页面：[VideoLAN 的 VLC 官方主页](https://www.videolan.org/vlc/)
- 原图：[Windows 桌面播放器截图](https://images.videolan.org/vlc/screenshots/3.0.0/3.0.17-windows11-fitted.jpg)
- 权利归属：VideoLAN 及截图内媒体、操作系统界面的相应权利人。
- 许可记录：网络图片，来源与再分发许可未确认；官网“部分图标采用共享许可”的说明不能扩大解释为本截图许可，软件开源许可也不涵盖视频画面。参见[VideoLAN 法律说明](https://www.videolan.org/legal.html)。页面已标注“网络图片”，侵权请联系管理员下架。
- 用途：引用实际播放器界面，不把视频中的城市景观作为独立风景素材使用。原样下载，不声称获得额外授权。

## 官方信息核对范围

数据中的 `verified` 仅表示以下官方页面的可读资料在标示日期已核对；不表示下载、安装、登录、选课、视频播放、校园身份认证、权益领取或端到端可用性经过测试。三步入门是编辑建议，不是逐步操作实测记录。

| 资源 | 实际读取的官方页面 | 资料核对范围 |
| --- | --- | --- |
| Zotero | [首页](https://www.zotero.org/)、[许可说明](https://www.zotero.org/support/licensing) | 免费、开源、文献整理与引用、平台入口、源码许可 |
| LibreOffice | [简体中文首页](https://zh-cn.libreoffice.org/)、[截图页](https://zh-cn.libreoffice.org/discover/page-826/) | 免费条件、办公组件、系统平台、文档格式和许可页脚；国际主站连接失败后改核对官方中文子站 |
| GIMP | [官方首页](https://www.gimp.org/) | 免费开源、图像编辑、系统平台和网站图片许可 |
| Blender | [官方许可说明](https://www.blender.org/about/license/) | 免费、软件许可、学生与商业创作使用边界；未作硬件性能测试 |
| VLC | [官方主页](https://www.videolan.org/vlc/)、[法律说明](https://www.videolan.org/legal.html) | 免费、跨平台、多媒体播放、使用和分发许可边界 |
| OBS Studio | [首页](https://obsproject.com/)、[官方帮助与常见问题](https://obsproject.com/help) | 免费开源、录制与直播、系统平台、GNU GPL 第二版；尝试的单独许可知识库地址返回未找到，不作为来源 |
| Git | [官方介绍](https://git-scm.com/about) | 版本管理、命令行与工具生态、GNU GPL 第二版；主页连接失败后读取介绍页 |
| Python | [官方介绍](https://www.python.org/about/) | 入门、用途、开源与使用分发许可；未运行解释器或第三方包 |
| MIT OpenCourseWare | [首页](https://ocw.mit.edu/)、[隐私与使用条款](https://ocw.mit.edu/pages/privacy-and-terms-of-use/) | 资料免费、无需注册、课程材料入口、非商业共享许可；未验证每门课材料齐全程度 |
| GitHub Education | [官方学生申请文档](https://docs.github.com/en/education/about-github-education/github-education-for-students/apply-to-github-education-as-a-student) | 年龄、在读证明、个人账户、教育邮箱条件与审核后权益；未提交任何学生材料 |

### 待复核，未标记为官方资料已核对

- [Inkscape 官方站点](https://inkscape.org/)与介绍、学习子页面：本轮出现超时、连接失败及网关错误，未取得足够官方正文；列为 `review`，`checkedAt` 为 `null`，无配图。其许可证版本须用户在官方发行包中复核。
- [国家高等教育智慧教育平台](https://higher.smartedu.cn/)与[关于页面](https://higher.smartedu.cn/help)：请求返回成功及关于页面标题，但正文提取空白；官方关于页的搜索摘要提及教育部主办与免费共享，但摘要不足以视作正文核对，所以仍列为 `review`，`checkedAt` 为 `null`。未登录、注册、选课或确认三江学院学分互认。

## 复用提醒

本站只提供官方入口和学习建议。每项资源的当前费用、资格、许可证、地区限制和平台条款可能变化，使用前请在对应官方页面重新确认。特别是学生权益需个人申请，不存在本目录可以保证的“三江学院已授权”状态。
