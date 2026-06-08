const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');
const XLSX = require('xlsx');
const inquirer = require('inquirer');
const Configstore = require('configstore');
const { format } = require('date-fns');
const { zhCN } = require('date-fns/locale');
const pkg = require('../package.json');
const { loadStoreFromInput } = require('./clean');
const { generateTextSummary } = require('./summary');
const {
  logInfo,
  logSuccess,
  logWarning,
  logError,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatDateKey,
  ensureDir,
  safeFileName,
  parseDate,
  getWeekRange,
} = require('../lib/utils');

async function exportCommand(input, options, cmd) {
  const {
    format: outputFormat = 'xlsx',
    output,
    type = 'daily',
    date,
    startDate,
    endDate,
    saveConfig,
    loadConfig,
    listConfigs,
    deleteConfig,
    configName,
    interactive,
    includeChart = false,
    includeSummary = true,
    includeRaw = false,
  } = options;
  const conf = new Configstore(pkg.name);
  if (listConfigs) {
    const configs = conf.get('savedConfigs') || {};
    console.log(chalk.cyan('\n=== 已保存的配置 ==='));
    if (Object.keys(configs).length === 0) {
      console.log(chalk.gray('暂无保存的配置'));
    } else {
      for (const [name, config] of Object.entries(configs)) {
        console.log(`  ${chalk.green(name)}: ${config.description || '无描述'}`);
        console.log(`    文件: ${config.files?.join(', ') || '未设置'}`);
        console.log(`    列名: 日期=${config.columns?.dateColumn || '-'}, 金额=${config.columns?.amountColumn || '-'}`);
        console.log('');
      }
    }
    return;
  }
  if (deleteConfig) {
    const configs = conf.get('savedConfigs') || {};
    const name = configName || deleteConfig;
    if (configs[name]) {
      delete configs[name];
      conf.set('savedConfigs', configs);
      logSuccess(`已删除配置: ${name}`);
    } else {
      logError(`配置不存在: ${name}`);
    }
    return;
  }
  if (loadConfig) {
    const configs = conf.get('savedConfigs') || {};
    const name = configName || loadConfig;
    const config = configs[name];
    if (!config) {
      logError(`配置不存在: ${name}`);
      process.exit(1);
    }
    logInfo(`已加载配置: ${name}`);
    if (config.files && config.files.length > 0 && !input) {
      options.files = config.files;
    }
    if (config.columns) {
      options.dateColumn = config.columns.dateColumn;
      options.amountColumn = config.columns.amountColumn;
      options.channelColumn = config.columns.channelColumn;
      options.quantityColumn = config.columns.quantityColumn;
    }
    if (config.cleanOptions) {
      options.filterZero = config.cleanOptions.filterZero;
      options.filterNegative = config.cleanOptions.filterNegative;
      options.noMerge = config.cleanOptions.noMerge;
    }
  }
  if (!input && !interactive && !options.files) {
    logError('请指定输入文件路径或使用 --load-config 加载配置');
    console.log('示例: report export cleaned.json --format xlsx --output report.xlsx');
    process.exit(1);
  }
  let inputFile = input || (options.files && options.files[0]);
  if (interactive && !inputFile) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: '请输入数据文件路径:',
        validate: (val) => fs.existsSync(val) || '文件不存在',
      },
      {
        type: 'list',
        name: 'format',
        message: '选择导出格式:',
        choices: ['xlsx', 'csv', 'json', 'txt'],
        default: 0,
      },
      {
        type: 'input',
        name: 'output',
        message: '请输入输出文件路径:',
        default: (ans) => `report_${formatDateKey(new Date())}.${ans.format}`,
      },
      {
        type: 'confirm',
        name: 'saveConfig',
        message: '是否保存当前配置以便下次使用?',
        default: false,
      },
    ]);
    inputFile = answers.input;
    options.format = answers.format;
    options.output = answers.output;
    options.saveConfig = answers.saveConfig;
  }
  let store;
  try {
    store = loadStoreFromInput(inputFile);
    store.clean({ mergeChannels: !options.noMerge });
  } catch (err) {
    logError(`加载数据失败: ${err.message}`);
    process.exit(1);
  }
  if (saveConfig) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'configName',
        message: '请输入配置名称:',
        default: 'default',
      },
      {
        type: 'input',
        name: 'description',
        message: '请输入配置描述（可选）:',
        default: '',
      },
    ]);
    const configs = conf.get('savedConfigs') || {};
    configs[answers.configName] = {
      name: answers.configName,
      description: answers.description,
      files: [inputFile],
      columns: { ...store.columns },
      cleanOptions: {
        filterZero: options.filterZero,
        filterNegative: options.filterNegative,
        noMerge: options.noMerge,
      },
      createdAt: new Date().toISOString(),
    };
    conf.set('savedConfigs', configs);
    logSuccess(`配置已保存为: ${answers.configName}`);
  }
  let dateRange = null;
  if (type === 'daily') {
    const targetDate = date ? parseDate(date) : new Date();
    dateRange = { start: targetDate, end: targetDate };
  } else if (type === 'weekly') {
    const baseDate = date ? parseDate(date) : new Date();
    dateRange = getWeekRange(baseDate);
  } else if (type === 'custom') {
    const start = startDate ? parseDate(startDate) : null;
    const end = endDate ? parseDate(endDate) : null;
    if (start && end) dateRange = { start, end };
  }
  const summary = store.getSummary(dateRange);
  const dailyData = store.groupByDate(dateRange);
  const channelData = store.groupByChannel(dateRange);
  const anomalies = store.detectAnomalies(dateRange);
  let outputPath = output;
  if (!outputPath) {
    const defaultName = `${type}_report_${formatDateKey(new Date())}.${outputFormat}`;
    outputPath = path.resolve(process.cwd(), defaultName);
  } else {
    outputPath = path.resolve(outputPath);
  }
  ensureDir(path.dirname(outputPath));
  logInfo(`正在导出到: ${outputPath}`);
  if (outputFormat === 'xlsx') {
    exportToExcel(store, summary, dailyData, channelData, anomalies, outputPath, { includeSummary, includeRaw, dateRange, type });
  } else if (outputFormat === 'csv') {
    exportToCSV(store, summary, dailyData, channelData, anomalies, outputPath, { dateRange });
  } else if (outputFormat === 'json') {
    exportToJSON(store, summary, dailyData, channelData, anomalies, outputPath, { dateRange, type });
  } else if (outputFormat === 'txt') {
    exportToTXT(store, summary, dailyData, channelData, anomalies, outputPath, { type });
  } else {
    logError(`不支持的导出格式: ${outputFormat}`);
    process.exit(1);
  }
  logSuccess(`导出完成！文件已保存到: ${outputPath}`);
  if (includeChart && outputFormat !== 'json' && outputFormat !== 'txt') {
    const chartPath = path.join(
      path.dirname(outputPath),
      `${path.basename(outputPath, path.extname(outputPath))}_chart.svg`
    );
    const chartModule = require('./chart');
    try {
      logInfo(`正在生成图表...`);
      const dataPoints = dailyData.map(d => d.totalAmount);
      const labels = dailyData.map(d => format(d.date, 'MM-dd', { locale: zhCN }));
      const generateSVG = chartModule.generateSVG || require('./chart').generateSVG;
      const svgContent = generateSVG(
        dataPoints,
        labels,
        `${type === 'daily' ? '每日' : '每周'}销售额趋势`,
        'line',
        800,
        40
      );
      fs.writeFileSync(chartPath, svgContent, 'utf-8');
      logSuccess(`图表已保存到: ${chartPath}`);
    } catch (err) {
      logWarning(`生成图表失败: ${err.message}`);
    }
  }
  return {
    outputPath,
    format: outputFormat,
    records: summary.totalRows,
  };
}

function exportToExcel(store, summary, dailyData, channelData, anomalies, outputPath, options) {
  const wb = XLSX.utils.book_new();
  if (options.includeSummary) {
    const summaryData = [
      ['指标', '数值'],
      ['总销售额', summary.totalAmount],
      ['订单数', summary.totalRows],
      ['总销量', summary.totalQuantity],
      ['覆盖天数', summary.dateCount],
      ['日均销售额', summary.avgDailyAmount],
      ['客单价', summary.avgAmount],
      ['单笔最高', summary.maxAmount],
      ['单笔最低', summary.minAmount],
      ['活跃渠道数', summary.channelCount],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    ws1['!cols'] = [{ wch: 20 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws1, '汇总');
    if (dailyData.length > 0) {
      const dailyHeaders = ['日期', '星期', '销售额', '订单数'];
      if (store.columns.quantityColumn) dailyHeaders.push('销量');
      const dailyRows = dailyData.map(d => [
        d.dateKey,
        format(d.date, 'EEEE', { locale: zhCN }),
        d.totalAmount,
        d.rowCount,
        store.columns.quantityColumn ? d.totalQuantity : undefined,
      ].filter(v => v !== undefined));
      const ws2 = XLSX.utils.aoa_to_sheet([dailyHeaders, ...dailyRows]);
      ws2['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 15 }, { wch: 10 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws2, '每日明细');
    }
    if (channelData.length > 0) {
      const channelHeaders = ['排名', '渠道', '销售额', '占比', '订单数'];
      if (store.columns.quantityColumn) channelHeaders.push('销量');
      const channelRows = channelData.map((c, idx) => [
        idx + 1,
        c.channel,
        c.totalAmount,
        summary.totalAmount > 0 ? c.totalAmount / summary.totalAmount : 0,
        c.rowCount,
        store.columns.quantityColumn ? c.totalQuantity : undefined,
      ].filter(v => v !== undefined));
      const ws3 = XLSX.utils.aoa_to_sheet([channelHeaders, ...channelRows]);
      ws3['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 15 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws3, '渠道明细');
    }
    if (anomalies.length > 0) {
      const anomalyHeaders = ['级别', '类型', '日期', '说明'];
      const anomalyRows = anomalies.map(a => [
        a.severity === 'high' ? '高' : a.severity === 'medium' ? '中' : '低',
        a.type,
        a.dateKey,
        a.message,
      ]);
      const ws4 = XLSX.utils.aoa_to_sheet([anomalyHeaders, ...anomalyRows]);
      ws4['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 12 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, ws4, '异常提醒');
    }
  }
  if (options.includeRaw) {
    const validRows = store.getValidRows();
    if (validRows.length > 0) {
      const headers = ['日期', '金额'];
      if (store.columns.channelColumn) headers.push('渠道');
      if (store.columns.quantityColumn) headers.push('数量');
      const rawRows = validRows.map(r => [
        r._parsedDate ? formatDateKey(r._parsedDate) : '',
        r._parsedAmount,
        store.columns.channelColumn ? (r[store.columns.channelColumn] || '') : undefined,
        store.columns.quantityColumn ? r._parsedQuantity : undefined,
      ].filter(v => v !== undefined));
      const ws5 = XLSX.utils.aoa_to_sheet([headers, ...rawRows]);
      XLSX.utils.book_append_sheet(wb, ws5, '原始数据');
    }
  }
  XLSX.writeFile(wb, outputPath);
}

function exportToCSV(store, summary, dailyData, channelData, anomalies, outputPath, options) {
  const lines = [];
  lines.push('=== 汇总数据 ===');
  lines.push('指标,数值');
  lines.push(`总销售额,${summary.totalAmount}`);
  lines.push(`订单数,${summary.totalRows}`);
  lines.push(`覆盖天数,${summary.dateCount}`);
  lines.push(`日均销售额,${summary.avgDailyAmount}`);
  lines.push('');
  if (dailyData.length > 0) {
    lines.push('=== 每日明细 ===');
    const headers = ['日期', '销售额', '订单数'];
    if (store.columns.quantityColumn) headers.push('销量');
    lines.push(headers.join(','));
    for (const d of dailyData) {
      const row = [d.dateKey, d.totalAmount, d.rowCount];
      if (store.columns.quantityColumn) row.push(d.totalQuantity);
      lines.push(row.join(','));
    }
    lines.push('');
  }
  if (channelData.length > 0) {
    lines.push('=== 渠道明细 ===');
    const headers = ['排名', '渠道', '销售额', '占比', '订单数'];
    if (store.columns.quantityColumn) headers.push('销量');
    lines.push(headers.join(','));
    channelData.forEach((c, idx) => {
      const share = summary.totalAmount > 0 ? (c.totalAmount / summary.totalAmount).toFixed(4) : 0;
      const row = [idx + 1, c.channel, c.totalAmount, share, c.rowCount];
      if (store.columns.quantityColumn) row.push(c.totalQuantity);
      lines.push(row.join(','));
    });
  }
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}

function exportToJSON(store, summary, dailyData, channelData, anomalies, outputPath, options) {
  const result = {
    exportTime: new Date().toISOString(),
    reportType: options.type,
    summary: {
      totalAmount: summary.totalAmount,
      totalRows: summary.totalRows,
      totalQuantity: summary.totalQuantity,
      avgAmount: summary.avgAmount,
      avgDailyAmount: summary.avgDailyAmount,
      maxAmount: summary.maxAmount,
      minAmount: summary.minAmount,
      dateCount: summary.dateCount,
      channelCount: summary.channelCount,
    },
    dailyData: dailyData.map(d => ({
      date: d.dateKey,
      totalAmount: d.totalAmount,
      totalQuantity: d.totalQuantity,
      rowCount: d.rowCount,
    })),
    channelData: channelData.map(c => ({
      channel: c.channel,
      totalAmount: c.totalAmount,
      totalQuantity: c.totalQuantity,
      rowCount: c.rowCount,
      share: summary.totalAmount > 0 ? c.totalAmount / summary.totalAmount : 0,
    })),
    anomalies: anomalies.map(a => ({
      severity: a.severity,
      type: a.type,
      dateKey: a.dateKey,
      message: a.message,
      value: a.value,
      deviation: a.deviation,
    })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

function exportToTXT(store, summary, dailyData, channelData, anomalies, outputPath, options) {
  const textContent = generateTextSummary(summary, dailyData, channelData, anomalies, options.type);
  fs.writeFileSync(outputPath, textContent.replace(/\x1b\[[0-9;]*m/g, ''), 'utf-8');
}

module.exports = exportCommand;
