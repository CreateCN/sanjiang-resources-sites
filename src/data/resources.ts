/**
 * 面向三江学院学生的独立资源目录，不代表学校采购、授权或合作。
 * verified 只表示 checkedAt 当日已核对官方页面中的信息；不表示软件实测、
 * 校园身份验证成功、网络可达性保证或申请权益成功。入门步骤为编辑建议。
 */
export const categories = [
  { id: 'all', name: '全部资源' },
  { id: 'writing', name: '写作阅读' },
  { id: 'development', name: '编程开发' },
  { id: 'design', name: '设计创作' },
  { id: 'learning', name: '课程学习' },
  { id: 'efficiency', name: '效率协作' },
] as const;

export type CategoryId = (typeof categories)[number]['id'];

export interface Resource {
  id: string;
  title: string;
  summary: string;
  category: Exclude<CategoryId, 'all'>;
  kind: '开源工具' | '免费课程' | '学生权益' | '公共资源';
  cost: string;
  platforms: string[];
  tags: string[];
  url: string;
  sourceUrl: string;
  license: string;
  eligibility: string;
  caveat: string;
  steps: string[];
  status: 'review' | 'verified';
  checkedAt: string | null;
  image?: string;
  imageAlt?: string;
  access?: 'open' | 'student-verification' | 'campus-network' | 'application' | 'conditional' | 'unknown';
  imageRights?: 'confirmed' | 'unconfirmed';
  imageCredit?: string;
}

export const resources: Resource[] = [
  {
    id: 'zotero',
    access: 'open',
    title: 'Zotero 文献管理',
    summary: '把论文、网页和阅读笔记整理进同一个文献库，写课程论文时快速生成引用与参考文献。',
    category: 'writing', kind: '开源工具', cost: '软件免费；扩容另计',
    platforms: ['Windows', 'macOS', 'Linux', 'iOS', 'Android'],
    tags: ['论文写作', '文献管理', '参考文献'],
    url: 'https://www.zotero.org/', sourceUrl: 'https://www.zotero.org/',
    license: '源码主要采用 GNU AGPL 第三版，例外以文件声明为准。',
    eligibility: '任何人可使用桌面软件，无需三江学院校园授权；在线同步需账户。',
    caveat: '免费软件不等于无限附件云空间，也不提供付费论文访问权；仅核对官方页面，未实测同步或校园访问。',
    steps: ['从官网下载软件与浏览器连接器。', '新建课程文献集，导入一篇可合法阅读的论文。', '核对作者和年份，再插入引用或导出参考文献。'],
    status: 'verified', checkedAt: '2026-10-20',
    image: '/images/zotero-interface.png', imageAlt: 'Zotero 官方展示的文献库、阅读器与笔记界面',
    imageRights: 'unconfirmed', imageCredit: '网络图片（Zotero 官网截图），来源与再分发授权未确认',
  },
  {
    id: 'libreoffice',
    access: 'open',
    title: 'LibreOffice 办公套件',
    summary: '用 Writer 写报告、Calc 整理实验数据、Impress 做课堂展示，不必先购买办公软件订阅。',
    category: 'writing', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['课程报告', '表格', '演示文稿'],
    url: 'https://zh-cn.libreoffice.org/', sourceUrl: 'https://zh-cn.libreoffice.org/',
    license: '软件源码采用 Mozilla 公共许可证第二版；第三方组件以各自声明为准。',
    eligibility: '个人和企业均可免费使用，无需学生身份或学校统一授权。',
    caveat: '复杂的微软办公文档、字体和宏可能存在兼容差异；提交作业前请自行核对排版，未进行文档兼容性实测。',
    steps: ['在简体中文官网下载适合系统的安装包。', '选择文档、表格或演示组件，新建一份作业。', '保留开放文档格式原稿，按要求导出或另存后检查。'],
    status: 'verified', checkedAt: '2026-10-20',
    image: '/images/libreoffice-interface.png', imageAlt: 'LibreOffice 中文官网展示的 Writer 主界面及侧边栏',
    imageRights: 'confirmed', imageCredit: 'The Document Foundation / LibreOffice 简体中文社区，CC BY-SA 3.0',
  },
  {
    id: 'gimp',
    access: 'open',
    title: 'GIMP 图像编辑',
    summary: '处理社团海报、课程配图和照片，使用图层、选区与修图工具完成常见图像编辑。',
    category: 'design', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['图像处理', '海报', '照片编辑'],
    url: 'https://www.gimp.org/', sourceUrl: 'https://www.gimp.org/',
    license: 'GNU 通用公共许可证；具体版本与组件声明见发行包。',
    eligibility: '面向所有用户开放，无需校园身份。',
    caveat: '软件开源不代表导入的照片、字体或素材可自由传播；仅核对官网介绍，未实测插件和文件兼容性。',
    steps: ['从官网下载对应系统版本。', '打开有权使用的图片，练习裁剪和图层。', '保留工程文件，并导出所需图片格式。'],
    status: 'verified', checkedAt: '2026-10-20',
    image: '/images/gimp.png', imageAlt: 'GIMP 官方网站首页的产品介绍与下载入口截图',
    imageRights: 'confirmed', imageCredit: "GIMP's Team，界面作品 Mica Semrick，CC BY-SA 4.0",
  },
  {
    id: 'inkscape',
    access: 'unknown',
    title: 'Inkscape 矢量绘图',
    summary: '面向图标、示意图和海报的矢量绘图工具，适合尝试可缩放的课程插图。',
    category: 'design', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['矢量绘图', '图标', '示意图'],
    url: 'https://inkscape.org/', sourceUrl: 'https://inkscape.org/about/',
    license: '项目采用 GNU 通用公共许可证；本轮未成功读取官方许可正文，使用前请复核。',
    eligibility: '一般用户可使用，无学校授权承诺。',
    caveat: '本轮官方站点抓取多次超时或连接失败，资料待复核；未实测下载、安装及格式兼容性。',
    steps: ['访问官网，先核对当前下载页与系统要求。', '新建画布，用形状和路径绘制一张示意图。', '保存矢量原稿，按作业要求导出图片。'],
    status: 'review', checkedAt: null,
  },
  {
    id: 'blender',
    access: 'open',
    title: 'Blender 三维创作',
    summary: '从三维建模到动画与渲染，为产品设计练习、空间表达和创意短片提供开放工具。',
    category: 'design', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['三维建模', '动画', '渲染'],
    url: 'https://www.blender.org/', sourceUrl: 'https://www.blender.org/about/license/',
    license: '发行二进制采用 GNU GPL 第三版或更新版本；部分源码组件另有兼容许可。',
    eligibility: '任何人可使用，包括学生与商业创作者；无需学校采购授权。',
    caveat: '软件许可不会自动授权第三方模型、贴图和字体；渲染效果与性能取决于设备，未实测本机安装。',
    steps: ['从官网下载并查看硬件要求。', '跟随官方手册完成一个简单模型。', '保存工程并尝试渲染一张静态图片。'],
    status: 'verified', checkedAt: '2026-10-20',
  },
  {
    id: 'vlc',
    access: 'open',
    title: 'VLC 媒体播放器',
    summary: '播放课程视频、录音和常见多媒体文件，适合整理本地学习资料与检查视频作业。',
    category: 'efficiency', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux', 'Android', 'iOS'], tags: ['视频播放', '音频', '本地学习'],
    url: 'https://www.videolan.org/vlc/', sourceUrl: 'https://www.videolan.org/vlc/',
    license: 'VideoLAN 软件采用 GNU GPL 或 LGPL 等开源许可，具体以所下载产品的许可文件为准。',
    eligibility: '所有用户可下载，无需校园身份。',
    caveat: '媒体播放能力不构成内容版权授权，也不保证所有编码和受保护媒体均可播放；未实测播放。',
    steps: ['从 VideoLAN 官网选择系统版本。', '打开一段有权播放的本地课程视频。', '按需调整字幕、播放速度与音轨。'],
    status: 'verified', checkedAt: '2026-10-20',
    image: '/images/vlc-interface.jpg', imageAlt: 'VideoLAN 官网展示的 VLC 播放器桌面界面',
    imageRights: 'unconfirmed', imageCredit: '网络图片（VideoLAN 官网截图），来源与再分发授权未确认',
  },
  {
    id: 'obs-studio',
    access: 'open',
    title: 'OBS Studio 录屏直播',
    summary: '录制答辩演示、操作教程与社团活动，用场景和音频混音组织屏幕、摄像头等画面来源。',
    category: 'efficiency', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['录屏', '答辩演示', '直播'],
    url: 'https://obsproject.com/', sourceUrl: 'https://obsproject.com/help',
    license: 'GNU GPL 第二版，具体发行包许可与组件声明请另行查阅。',
    eligibility: '任何人可免费使用，无需学生认证；直播平台账户要求另计。',
    caveat: '录制课程、会议或他人肖像前应取得必要同意；硬件和平台规则可能限制录制与推流，未实测。',
    steps: ['从官网下载并运行自动配置向导。', '新建场景，添加窗口画面和麦克风。', '先录一小段，检查画面与声音再正式录制。'],
    status: 'verified', checkedAt: '2026-10-20',
    image: '/images/obs-interface.png', imageAlt: 'OBS Studio 官方展示的场景、视频预览与音频混音界面',
    imageRights: 'unconfirmed', imageCredit: '网络图片（OBS 官网演示画面），来源与再分发授权未确认',
  },
  {
    id: 'git',
    access: 'open',
    title: 'Git 版本管理',
    summary: '记录课程代码与文档的修改历史，为小组开发建立可追踪、可协作的版本管理习惯。',
    category: 'development', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['版本控制', '小组作业', '代码管理'],
    url: 'https://git-scm.com/', sourceUrl: 'https://git-scm.com/about',
    license: 'GNU GPL 第二版。',
    eligibility: '任何人可使用；本地版本管理无需代码托管账户。',
    caveat: 'Git 不等于 GitHub，远程托管服务有各自条款；不要提交密码或个人隐私，未实测远程协作。',
    steps: ['从官方安装入口获取 Git 并阅读入门文档。', '为练习目录初始化仓库并设置提交署名。', '提交一次修改，再查看版本历史。'],
    status: 'verified', checkedAt: '2026-10-20',
  },
  {
    id: 'python',
    access: 'open',
    title: 'Python 编程语言',
    summary: '从第一个脚本开始，逐步学习编程基础、数据整理与重复任务自动化。',
    category: 'development', kind: '开源工具', cost: '免费',
    platforms: ['Windows', 'macOS', 'Linux'], tags: ['编程入门', '数据处理', '自动化'],
    url: 'https://www.python.org/', sourceUrl: 'https://www.python.org/about/',
    license: 'Python 软件基金会管理的开源许可；第三方软件包各有许可。',
    eligibility: '面向所有学习者，可免费使用，无需学校授权。',
    caveat: '第三方课程、云算力和软件包服务可能收费；请核对系统支持与包来源，未实测运行或安装。',
    steps: ['从官网获取适合系统的稳定版本。', '阅读官方入门指南，运行第一个输出程序。', '用一份不含隐私的样例数据练习小脚本。'],
    status: 'verified', checkedAt: '2026-10-20',
  },
  {
    id: 'mit-ocw',
    access: 'open',
    title: 'MIT OpenCourseWare 开放课程',
    summary: '免费查阅麻省理工学院公开的讲义、习题和部分课程视频，补充数学、计算机与跨学科学习。',
    category: 'learning', kind: '免费课程', cost: '课程资料免费',
    platforms: ['网页'], tags: ['公开课', '自主学习', '英文课程'],
    url: 'https://ocw.mit.edu/', sourceUrl: 'https://ocw.mit.edu/',
    license: '通常为知识共享署名—非商业性使用—相同方式共享第四版；例外材料遵循单独标注。',
    eligibility: '公开资料无需注册，不要求三江学院学生身份。',
    caveat: '公开学习资料不等于录取、学分或证书；课程不一定包含视频或完整答案，未实测视频播放及下载。',
    steps: ['按学科或关键词寻找适合程度的课程。', '阅读课程大纲，确认先修知识和材料清单。', '按周学习讲义并练习习题，自行记录进度。'],
    status: 'verified', checkedAt: '2026-10-20',
  },
  {
    id: 'smart-education',
    access: 'conditional',
    title: '国家高等教育智慧教育平台',
    summary: '查找高校在线课程与教学资源，为专业课预习、复习和跨学科探索寻找中文学习入口。',
    category: 'learning', kind: '公共资源', cost: '开放资源免费；以课程页为准',
    platforms: ['网页'], tags: ['中文课程', '高校课程', '自主学习'],
    url: 'https://higher.smartedu.cn/', sourceUrl: 'https://higher.smartedu.cn/help',
    license: '课程与材料版权归相应权利人所有；免费访问不代表开放转载许可。',
    eligibility: '面向高校师生和社会学习者；具体课程的注册和使用要求以提供方为准。',
    caveat: '官方关于页面可访问，但本轮文本抓取未返回完整正文，暂列待复核；未登录、选课或测试视频，不承诺校内学分互认。',
    steps: ['打开平台，按学科或课程名称检索。', '进入课程提供方页面核对费用与注册要求。', '选择公开学习内容，记录课程来源和学习计划。'],
    status: 'review', checkedAt: null,
  },
  {
    id: 'github-education',
    access: 'student-verification',
    title: 'GitHub Education 学生权益',
    summary: '符合条件的学生可提交个人申请，审核通过后探索开发工具与学习资源权益。',
    category: 'development', kind: '学生权益', cost: '审核通过后可享免费权益',
    platforms: ['网页'], tags: ['学生认证', '开发工具', '条件申请'],
    url: 'https://github.com/education',
    sourceUrl: 'https://docs.github.com/en/education/about-github-education/github-education-for-students/apply-to-github-education-as-a-student',
    license: '受 GitHub Education 与各合作方条款约束，不是统一的开源软件许可。',
    eligibility: '年满十三岁，拥有个人账户，正在就读可授予学位或文凭的项目，并提供当前在读证明；按申请要求验证教育邮箱。',
    caveat: '不代表三江学院已获授权或学生必然通过；各权益资格、地区、期限可能不同。本轮仅核对官方申请文档，未提交身份或实测领取。',
    steps: ['阅读官方资格说明，准备当前在读证明。', '在账户教育权益设置中按要求提交个人申请。', '审核通过后，逐项核对合作方条款再启用。'],
    status: 'verified', checkedAt: '2026-10-20',
  },
];
