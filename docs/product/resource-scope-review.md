# 原资源适用范围（scope）人工审核清单

> 迁移不批量改写旧数据。下列条目升级后仍为 `unknown`，需要维护者逐条核对官方说明后再决定
> `global` 或 `institutions`。`unknown` 在前台显示“适用范围待确认，请查阅资格说明”。

审核要求：

- `scope` 与 `access` 独立：学生认证（student-verification）不等于全局可用，也不等于仅限某校。
- `global` 只表示不面向特定机构，不表示永久免费、无地区限制或无需个人资格。
- `institutions` 名称只作说明，不建立学校关系表；不要把“面向大学生”推断为某校已订阅。
- 审核不改变已有公开快照；只有发布后才生效。

| ID | 现状 | 待核对重点 | 建议 |
|---|---|---|---|
| zotero | unknown | 公开桌面端；同步空间收费 | 核对后可为 global，保留费用说明 |
| libreoffice | unknown | 公开下载；第三方模板/字体许可 | 核对后可为 global |
| gimp | unknown | 公开下载 | 核对后可为 global |
| inkscape | unknown | 公开下载；教程与扩展许可 | 核对后可为 global，不因改造升级 verified |
| blender | unknown | 公开下载；云服务另计 | 核对后可为 global |
| vlc | unknown | 公开下载；移动端分发条款 | 核对后可为 global |
| obs-studio | unknown | 公开下载；插件许可 | 核对后可为 global |
| git | unknown | 公开下载；托管服务另计 | 核对后可为 global |
| python | unknown | 语言与官方文档公开 | 核对后可为 global |
| mit-ocw | unknown | 公开课程；署名与非商业条款按课程而异 | 核对后可为 global，逐课确认许可 |
| smart-education | unknown | 国家平台；部分课程/学校功能可能限地区或机构 | 先保持 unknown，按实际入口与地区确认 |
| github-education | unknown | 个人学生认证；资格、地区与权益可能变化 | 保持 global 候选但标 student-verification；不承诺通过 |

结论：**本轮不将任何条目升级为 global 或 verified**；原 12 条内容、核验日期、发布状态保持不变。
