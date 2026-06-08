const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');
const inquirer = require('inquirer');
const { format, startOfDay, subDays } = require('date-fns');
const { zhCN } = require('date-fns/locale');
const { loadStoreFromInput } = require('./clean');
const {
  logInfo,
  logSuccess,
  logWarning,
  logError,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatDateKey,
  formatDateDisplay,
  getWeekRange,
  ensureDir,
  parseDate,
} = require('../lib/utils');

function generateTextSummary(summary, dailyData, channelData, anomalies, reportType) {
  const lines = [];
  const today = new Date();
  const dateStr = format(today, 'yyyy年MM月dd日', { locale: zhCN });
  lines.push(chalk.bold.cyan(`【${reportType === 'daily' ? '日报' : '周报'}】${dateStr}`));
  lines.push('');
  lines.push(chalk.bold('一、整体概况'));
  lines.push(`  • 统计周期内总销售额：${chalk.green(formatCurrency(summary.totalAmount))}`);
  lines.push(`  • 总订单数：${chalk.cyan(formatNumber(summary.totalRows))}`);
  if (summary.totalQuantity > 0) {
    lines.push(`  • 总销量：${chalk.cyan(formatNumber(summary.totalQuantity))}`);
  }
  lines.push(`  • 覆盖天数：${chalk.cyan(formatNumber(summary.dateCount))} 天`);
  lines.push(`  • 日均销售额：${chalk.yellow(formatCurrency(summary.avgDailyAmount))}`);
  lines.push(`  • 客单价：${chalk.yellow(formatCurrency(summary.avgAmount))}`);
  lines.push('');
  if (summary.topChannels && summary.topChannels.length > 0) {
    lines.push(chalk.bold('二、渠道分布（TOP5）'));
    summary.topChannels.forEach((channel, idx) => {
      const share = summary.totalAmount > 0 ? (channel.totalAmount / summary.totalAmount) : 0;
      lines.push(`  ${idx + 1}. ${channel.channel}：${formatCurrency(channel.totalAmount)}（${formatPercent(share, 1)}）`);
    });
    lines.push('');
  }
  if (dailyData && dailyData.length > 0) {
    lines.push(chalk.bold('三、每日趋势'));
    const recentDays = dailyData.slice(-7);
    for (const day of recentDays) {
      const dow = format(day.date, 'EEE', { locale: zhCN });
      lines.push(`  • ${day.dateKey} ${dow}：${formatCurrency(day.totalAmount)}（${formatNumber(day.rowCount)} 单）`);
    }
    lines.push('');
  }
  if (anomalies && anomalies.length > 0) {
    lines.push(chalk.bold.red('四、异常提醒'));
    anomalies.forEach((anomaly, idx) => {
      const icon = anomaly.severity === 'high' ? '🔴' : '🟡';
      lines.push(`  ${icon} ${anomaly.message}`);
    });
    lines.push('');
  }
  lines.push(chalk.bold('五、关键指标'));
  lines.push(`  • 单笔最高：${formatCurrency(summary.maxAmount)}`);
  lines.push(`  • 单笔最低：${formatCurrency(summary.minAmount)}`);
  if (summary.channelCount > 0) {
    lines.push(`  • 活跃渠道数：${formatNumber(summary.channelCount)}`);
  }
  return lines.join('\n');
}

async function summaryCommand(input, options, cmd) {
  const {
    type = 'daily',
    date,
    startDate,
    endDate,
    threshold = 0.3,
    output,
    interactive,
    noAnomaly,
    exportText,
  } = options;
  if (!input && !interactive) {
    logError('请指定输入文件路径');
    console.log('示例: report summary cleaned.json --type daily');
    process.exit(1);
  }
  let inputFile = input;
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
        name: 'type',
        message: '选择报表类型:',
        choices: ['daily', 'weekly', 'custom'],
        default: 0,
      },
    ]);
    inputFile = answers.input;
    if (answers.type) options.type = answers.type;
  }
  let store;
  try {
    store = loadStoreFromInput(inputFile);
    store.clean({ mergeChannels: true });
  } catch (err) {
    logError(`加载数据失败: ${err.message}`);
    process.exit(1);
  }
  let dateRange = null;
  const reportType = type;
  if (type === 'daily') {
    const targetDate = date ? parseDate(date) : startOfDay(new Date());
    if (!targetDate) {
      logError('无效的日期格式');
      process.exit(1);
    }
    dateRange = { start: targetDate, end: targetDate };
    logInfo(`生成日报：${formatDateDisplay(targetDate)}`);
  } else if (type === 'weekly') {
    const baseDate = date ? parseDate(date) : new Date();
    if (!baseDate) {
      logError('无效的日期格式');
      process.exit(1);
    }
    dateRange = getWeekRange(baseDate);
    logInfo(`生成周报：${formatDateKey(dateRange.start)} ~ ${formatDateKey(dateRange.end)}`);
  } else if (type === 'custom') {
    const start = startDate ? parseDate(startDate) : subDays(new Date(), 6);
    const end = endDate ? parseDate(endDate) : new Date();
    if (!start || !end) {
      logError('无效的日期格式');
      process.exit(1);
    }
    dateRange = { start, end };
    logInfo(`生成自定义报表：${formatDateKey(start)} ~ ${formatDateKey(end)}`);
  }
  const summary = store.getSummary(dateRange);
  const dailyData = store.groupByDate(dateRange);
  const channelData = store.groupByChannel(dateRange);
  const anomalies = noAnomaly ? [] : store.detectAnomalies(dateRange, threshold);
  console.log(`\n${chalk.cyan('='.repeat(60))}`);
  console.log(generateTextSummary(summary, dailyData, channelData, anomalies, reportType));
  console.log(chalk.cyan('='.repeat(60)));
  if (dailyData && dailyData.length > 0) {
    console.log(`\n${chalk.cyan('=== 每日明细 ===')}`);
    const dailyTable = new Table({
      head: [
        chalk.white('日期'),
        chalk.white('星期'),
        chalk.white('销售额'),
        chalk.white('订单数'),
        store.columns.quantityColumn ? chalk.white('销量') : null,
        chalk.white('环比'),
      ].filter(Boolean),
      style: { head: [], border: [] },
    });
    for (let i = 0; i < dailyData.length; i++) {
      const day = dailyData[i];
      const prevDay = i > 0 ? dailyData[i - 1] : null;
      const change = prevDay && prevDay.totalAmount > 0
        ? (day.totalAmount - prevDay.totalAmount) / prevDay.totalAmount
        : 0;
      const changeStr = i === 0
        ? chalk.gray('-')
        : change > 0
          ? chalk.green(`+${formatPercent(change, 1)}`)
          : change < 0
            ? chalk.red(formatPercent(change, 1))
            : chalk.gray('0.0%');
      const rowData = [
        day.dateKey,
        format(day.date, 'EEE', { locale: zhCN }),
        formatCurrency(day.totalAmount),
        formatNumber(day.rowCount),
        store.columns.quantityColumn ? formatNumber(day.totalQuantity) : null,
        changeStr,
      ].filter(Boolean);
      dailyTable.push(rowData);
    }
    console.log(dailyTable.toString());
  }
  if (channelData && channelData.length > 0) {
    console.log(`\n${chalk.cyan('=== 渠道明细 ===')}`);
    const channelTable = new Table({
      head: [
        chalk.white('排名'),
        chalk.white('渠道'),
        chalk.white('销售额'),
        chalk.white('占比'),
        chalk.white('订单数'),
        store.columns.quantityColumn ? chalk.white('销量') : null,
      ].filter(Boolean),
      style: { head: [], border: [] },
    });
    channelData.slice(0, 10).forEach((channel, idx) => {
      const share = summary.totalAmount > 0 ? channel.totalAmount / summary.totalAmount : 0;
      const rowData = [
        idx + 1,
        channel.channel,
        formatCurrency(channel.totalAmount),
        formatPercent(share, 1),
        formatNumber(channel.rowCount),
        store.columns.quantityColumn ? formatNumber(channel.totalQuantity) : null,
      ].filter(Boolean);
      channelTable.push(rowData);
    });
    console.log(channelTable.toString());
  }
  const result = {
    reportType,
    dateRange: dateRange ? {
      start: dateRange.start.toISOString(),
      end: dateRange.end.toISOString(),
    } : null,
    summary,
    dailyData: dailyData.map(d => ({
      ...d,
      date: d.date.toISOString(),
      channels: Object.fromEntries(d.channels),
    })),
    channelData,
    anomalies,
  };
  if (output) {
    const outputPath = path.resolve(output);
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    logSuccess(`汇总结果已保存到: ${outputPath}`);
  }
  if (exportText) {
    const textPath = exportText === true
      ? path.resolve(path.dirname(inputFile), `${reportType}_report_${formatDateKey(new Date())}.txt`)
      : path.resolve(exportText);
    ensureDir(path.dirname(textPath));
    const textContent = generateTextSummary(summary, dailyData, channelData, anomalies, reportType);
    fs.writeFileSync(textPath, textContent.replace(/\x1b\[[0-9;]*m/g, ''), 'utf-8');
    logSuccess(`文本报告已保存到: ${textPath}`);
  }
  return result;
}

module.exports = { summaryCommand, generateTextSummary };
