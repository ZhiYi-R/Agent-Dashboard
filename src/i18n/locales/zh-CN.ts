export type MessageTree = {
  app: { title: string; subtitle: string };
  tabs: { overview: string; records: string; balance: string; settings: string };
  actions: {
    scan: string;
    scanning: string;
    fullScan: string;
    syncPrices: string;
    syncing: string;
    edit: string;
    save: string;
    cancel: string;
    reset: string;
    prev: string;
    next: string;
    add: string;
    refresh: string;
    off: string;
    on: string;
  };
  scan: { scanning: string; rows: string; prices: string };
  errors: { refresh: string; scan: string };
  overview: {
    records: string;
    sessions: string;
    cost: string;
    input: string;
    output: string;
    cache: string;
    dailyUsage: string;
    byAgent: string;
    byModel: string;
    agent: string;
    model: string;
    rec: string;
    hitRate: string;
    cacheHit: string;
    cacheWrite: string;
    reasoning: string;
  };
  records: {
    allAgents: string;
    allModels: string;
    allProjects: string;
    rangeOf: string;
    time: string;
    reason: string;
    unknown: string;
    empty: string;
  };
  filter: {
    today: string;
    last7d: string;
    last30d: string;
    thisMonth: string;
    allTime: string;
    custom: string;
    active: string;
    agentsSelected: string;
  };
  settings: {
    title: string;
    agents: string;
    status: string;
    enabled: string;
    path: string;
    detected: string;
    missing: string;
    autoRefresh: string;
    balanceInterval: string;
    usageInterval: string;
    min5: string;
    min15: string;
    min30: string;
    min60: string;
    modelOverrides: string;
    language: string;
    langZh: string;
    langEn: string;
    about: string;
    version: string;
    checkUpdate: string;
    checkingUpdate: string;
    updateAvailable: string;
    upToDate: string;
    openRelease: string;
    openDownload: string;
    latestVersion: string;
    noRelease: string;
  };
  theme: { label: string; light: string; dark: string; system: string };
  balance: {
    title: string;
    keys: string;
    ok: string;
    failed: string;
    edit: string;
    editTitle: string;
    addProviders: string;
    addProviderType: string;
    providerOption: string;
    name: string;
    type: string;
    keysLabel: string;
    baseUrl: string;
    baseUrlRequired: string;
    available: string;
    quota: string;
    statusOk: string;
    statusFailed: string;
    leftPct: string;
    leftUnit: string;
    keyPlaceholder: string;
    emptyKey: string;
    baseUrlRequiredErr: string;
    userIdPlaceholder: string;
    userIdRequiredErr: string;
    manageProviders: string;
    manageProvidersHint: string;
    addProvider: string;
    editProvider: string;
    history: string;
    historyEmpty: string;
    range7d: string;
    range30d: string;
    range90d: string;
    allKeys: string;
    availableSeries: string;
    quotaUsedSeries: string;
  };
  modelOverrides: {
    model: string;
    aliases: string;
    in: string;
    out: string;
    cacheRead: string;
    cacheWrite: string;
    reasoning: string;
  };
};

const zhCN: MessageTree = {
  app: {
    title: "Agent Statistics",
    subtitle: "Token 与费用仪表盘",
  },
  tabs: {
    overview: "概览",
    records: "记录",
    balance: "余额",
    settings: "设置",
  },
  actions: {
    scan: "扫描",
    scanning: "扫描中…",
    fullScan: "全量扫描",
    syncPrices: "同步价格",
    syncing: "同步中…",
    edit: "编辑",
    save: "保存",
    cancel: "取消",
    reset: "重置",
    prev: "上一页",
    next: "下一页",
    add: "添加",
    refresh: "刷新",
    off: "关闭",
    on: "开启",
  },
  scan: {
    scanning: "扫描中",
    rows: "{n} 条",
    prices: "价格",
  },
  errors: {
    refresh: "仪表盘刷新失败",
    scan: "扫描完成但存在错误",
  },
  overview: {
    records: "记录数",
    sessions: "会话数",
    cost: "费用",
    input: "输入",
    output: "输出",
    cache: "缓存",
    dailyUsage: "每日用量",
    byAgent: "按 Agent",
    byModel: "按模型",
    agent: "Agent",
    model: "模型",
    rec: "条数",
    hitRate: "命中率",
    cacheHit: "缓存命中",
    cacheWrite: "缓存写入",
    reasoning: "推理",
  },
  records: {
    allAgents: "全部 Agent",
    allModels: "全部模型",
    allProjects: "全部项目",
    rangeOf: "{from}-{to} / 共 {total}",
    time: "时间",
    reason: "推理",
    unknown: "<unknown>",
    empty: "当前筛选无记录",
  },
  filter: {
    today: "今天",
    last7d: "近 7 天",
    last30d: "近 30 天",
    thisMonth: "本月",
    allTime: "全部",
    custom: "自定义",
    active: "筛选中 · {detail}",
    agentsSelected: "{n} 个 Agent",
  },
  settings: {
    title: "设置",
    agents: "Agents",
    status: "状态",
    enabled: "启用",
    path: "路径",
    detected: "已检测到",
    missing: "未找到",
    autoRefresh: "自动刷新",
    balanceInterval: "余额刷新间隔",
    usageInterval: "用量扫描间隔",
    min5: "5 分钟",
    min15: "15 分钟",
    min30: "30 分钟",
    min60: "60 分钟",
    modelOverrides: "模型价格覆盖",
    language: "语言",
    langZh: "简体中文",
    langEn: "English",
    about: "关于与更新",
    version: "当前版本",
    checkUpdate: "检查更新",
    checkingUpdate: "检查中…",
    updateAvailable: "发现新版本 {version}",
    upToDate: "已是最新版本",
    openRelease: "打开发布页",
    openDownload: "下载安装包",
    latestVersion: "最新版本",
    noRelease: "尚未发布 GitHub Release",
  },
  theme: {
    label: "主题",
    light: "浅色",
    dark: "深色",
    system: "跟随系统",
  },
  balance: {
    title: "余额",
    keys: "{n} 个密钥",
    ok: "{n} 成功",
    failed: "{n} 失败",
    edit: "编辑",
    editTitle: "编辑余额配置",
    addProviders: "去添加供应商",
    addProviderType: "添加供应商类型",
    providerOption: "+ 供应商",
    name: "名称",
    type: "类型",
    keysLabel: "密钥",
    baseUrl: "Base URL",
    baseUrlRequired: "Base URL *",
    available: "可用",
    quota: "配额",
    statusOk: "正常",
    statusFailed: "失败",
    leftPct: "{used}% · 剩余 {left}%",
    leftUnit: "剩余 {n}{unit}",
    keyPlaceholder: "名称",
    emptyKey: "{provider} / {key}: 密钥为空",
    baseUrlRequiredErr: "{name}: 需要填写 Base URL",
    userIdPlaceholder: "用户 ID (New-Api-User)",
    userIdRequiredErr: "{provider} / {key}: 需要填写用户 ID",
    manageProviders: "管理供应商",
    manageProvidersHint: "添加、编辑或删除余额供应商，保存后生效。",
    addProvider: "添加供应商",
    editProvider: "编辑供应商",
    history: "配额与余额趋势",
    historyEmpty: "暂无历史快照，请先刷新余额",
    range7d: "近 7 天",
    range30d: "近 30 天",
    range90d: "近 90 天",
    allKeys: "全部密钥",
    availableSeries: "可用余额",
    quotaUsedSeries: "配额已用 %",
  },
  modelOverrides: {
    model: "模型",
    aliases: "别名",
    in: "输入",
    out: "输出",
    cacheRead: "缓存读",
    cacheWrite: "缓存写",
    reasoning: "推理",
  },
};

export default zhCN;
