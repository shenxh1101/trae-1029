const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');
const inquirer = require('inquirer');
const { format } = require('date-fns');
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
  getWeekRange,
  getLastWeekRange,
  isInDateRange,
  calculateChange,
  formatChange,
  ensureDir,
  parseDate,
} = require('../lib/utils');

async function compareCommand(input, options, cmd) {
  const {
    type = 'weekly',
    date,
    startDate,
    endDate,
    compareStart,
    compareEnd,
    byChannel = true,
    byDay = true,
    output,
    interactive,
  } = options;
  if (!input && !interactive) {
    logError('请指定输入文件路径');
    console.log('示例: report compare cleaned.json --type weekly');
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
        message: '选择对比类型:',
        choices: ['weekly', 'daily', 'custom'],
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
  let currentRange, compareRange;
  const baseDate = date ? parseDate(date) : new Date();
  if (!baseDate) {
    logError('无效的日期格式');
    process.exit(1);
  }
  if (type === 'weekly') {
    currentRange = getWeekRange(baseDate);
    compareRange = getLastWeekRange(baseDate);
    logInfo(`对比本周（${formatDateKey(currentRange.start)} ~ ${formatDateKey(currentRange.end)}）与上周（${formatDateKey(compareRange.start)} ~ ${formatDateKey(compareRange.end)}）`);
  } else if (type === 'daily') {
    currentRange = { start: baseDate, end: baseDate };
    const yesterday = new Date(baseDate);
    yesterday.setDate(yesterday.getDate() - 1);
    compareRange = { start: yesterday, end: yesterday };
    logInfo(`对比今天（${formatDateKey(currentRange.start)}）与昨天（${formatDateKey(compareRange.start)}）`);
  } else if (type === 'custom') {
    const start = startDate ? parseDate(startDate) : null;
    const end = endDate ? parseDate(endDate) : null;
    const cStart = compareStart ? parseDate(compareStart) : null;
    const cEnd = compareEnd ? parseDate(compareEnd) : null;
    if (!start || !end || !cStart || !cEnd) {
      logError('请指定完整的对比日期范围：--start-date, --end-date, --compare-start, --compare-end');
      process.exit(1);
    }
    currentRange = { start, end };
    compareRange = { start: cStart, end: cEnd };
    logInfo(`对比 ${formatDateKey(start)} ~ ${formatDateKey(end)} 与 ${formatDateKey(cStart)} ~ ${formatDateKey(cEnd)}`);
  }
  const currentSummary = store.getSummary(currentRange);
  const compareSummary = store.getSummary(compareRange);
  console.log(`\n${chalk.cyan('='.repeat(60))}`);
  console.log(chalk.bold.cyan(`【数据对比报告】`));
  console.log(chalk.cyan('='.repeat(60)));
  console.log(`\n${chalk.bold('一、整体对比')}`);
  const overallTable = new Table({
    head: [
      chalk.white('指标'),
      chalk.white('当前周期'),
      chalk.white('对比周期'),
      chalk.white('变化'),
    ],
    style: { head: [], border: [] },
    colWidths: [15, 20, 20, 15],
  });
  const amountChange = calculateChange(currentSummary.totalAmount, compareSummary.totalAmount);
  const rowsChange = calculateChange(currentSummary.totalRows, compareSummary.totalRows);
  const avgChange = calculateChange(currentSummary.avgAmount, compareSummary.avgAmount);
  const dailyChange = calculateChange(currentSummary.avgDailyAmount, compareSummary.avgDailyAmount);
  overallTable.push(
    ['总销售额', formatCurrency(currentSummary.totalAmount), formatCurrency(compareSummary.totalAmount), formatChange(amountChange)],
    ['订单数', formatNumber(currentSummary.totalRows), formatNumber(compareSummary.totalRows), formatChange(rowsChange)],
    ['客单价', formatCurrency(currentSummary.avgAmount), formatCurrency(compareSummary.avgAmount), formatChange(avgChange)],
    ['日均销售额', formatCurrency(currentSummary.avgDailyAmount), formatCurrency(compareSummary.avgDailyAmount), formatChange(dailyChange)],
  );
  if (currentSummary.totalQuantity > 0 || compareSummary.totalQuantity > 0) {
    const qtyChange = calculateChange(currentSummary.totalQuantity, compareSummary.totalQuantity);
    overallTable.push(['总销量', formatNumber(currentSummary.totalQuantity), formatNumber(compareSummary.totalQuantity), formatChange(qtyChange)]);
  }
  console.log(overallTable.toString());
  if (byChannel && store.columns.channelColumn) {
    console.log(`\n${chalk.bold('二、渠道对比（TOP10）')}`);
    const currentChannels = store.groupByChannel(currentRange);
    const compareChannels = store.groupByChannel(compareRange);
    const compareMap = new Map(compareChannels.map(c => [c.channel, c]));
    const channelTable = new Table({
      head: [
        chalk.white('排名'),
        chalk.white('渠道'),
        chalk.white('当前销售额'),
        chalk.white('对比销售额'),
        chalk.white('变化'),
        chalk.white('当前占比'),
      ],
      style: { head: [], border: [] },
    });
    const allChannels = new Set([
      ...currentChannels.map(c => c.channel),
      ...compareChannels.map(c => c.channel)
    ]);
    const mergedChannels = Array.from(allChannels).map(channel => {
      const curr = currentChannels.find(c => c.channel === channel) || { totalAmount: 0, totalQuantity: 0, rowCount: 0 };
      const prev = compareChannels.find(c => c.channel === channel) || { totalAmount: 0, totalQuantity: 0, rowCount: 0 };
      return {
        channel,
        currentAmount: curr.totalAmount,
        compareAmount: prev.totalAmount,
        change: calculateChange(curr.totalAmount, prev.totalAmount),
      };
    }).sort((a, b) => b.currentAmount - a.currentAmount);
    mergedChannels.slice(0, 10).forEach((ch, idx) => {
      const share = currentSummary.totalAmount > 0 ? ch.currentAmount / currentSummary.totalAmount : 0;
      channelTable.push([
        idx + 1,
        ch.channel,
        formatCurrency(ch.currentAmount),
        formatCurrency(ch.compareAmount),
        formatChange(ch.change),
        formatPercent(share, 1),
      ]);
    });
    console.log(channelTable.toString());
  }
  if (byDay && type === 'weekly') {
    console.log(`\n${chalk.bold('三、每日对比')}`);
    const currentDaily = store.groupByDate(currentRange);
    const compareDaily = store.groupByDate(compareRange);
    const dayTable = new Table({
      head: [
        chalk.white('日期'),
        chalk.white('星期'),
        chalk.white('当前销售额'),
        chalk.white('上周同期'),
        chalk.white('变化'),
      ],
      style: { head: [], border: [] },
    });
    for (let i = 0; i < currentDaily.length; i++) {
      const curr = currentDaily[i];
      const prev = compareDaily[i];
      const change = prev && prev.totalAmount > 0
        ? (curr.totalAmount - prev.totalAmount) / prev.totalAmount
        : 0;
      dayTable.push([
        curr.dateKey,
        format(curr.date, 'EEE', { locale: zhCN }),
        formatCurrency(curr.totalAmount),
        prev ? formatCurrency(prev.totalAmount) : '-',
        prev ? formatChange(change) : chalk.gray('-'),
      ]);
    }
    console.log(dayTable.toString());
  }
  const significantChanges = [];
  if (Math.abs(amountChange) > 0.2) {
    significantChanges.push({
      type: '整体销售额',
      change: amountChange,
      message: `整体销售额${amountChange > 0 ? '增长' : '下降'} ${formatPercent(Math.abs(amountChange), 1)}`,
    });
  }
  if (byChannel && store.columns.channelColumn) {
    const currentChannels = store.groupByChannel(currentRange);
    const compareMap = new Map(store.groupByChannel(compareRange).map(c => [c.channel, c]));
    for (const ch of currentChannels) {
      const prev = compareMap.get(ch.channel);
      const change = prev ? calculateChange(ch.totalAmount, prev.totalAmount) : Infinity;
      if (Math.abs(change) > 0.3 && ch.totalAmount > currentSummary.totalAmount * 0.05) {
        significantChanges.push({
          type: '渠道',
          channel: ch.channel,
          change,
          message: `${ch.channel} 渠道销售额${change > 0 ? '增长' : '下降'} ${formatPercent(Math.abs(change), 1)}`,
        });
      }
    }
  }
  if (significantChanges.length > 0) {
    console.log(`\n${chalk.bold.red('四、显著变化提醒')}`);
    for (const item of significantChanges) {
      const icon = item.change > 0.5 ? '📈' : item.change > 0.2 ? '📊' : '📉';
      const severity = Math.abs(item.change) > 0.5 ? chalk.red : Math.abs(item.change) > 0.3 ? chalk.yellow : chalk.blue;
      console.log(`  ${icon} ${severity(item.message)}`);
    }
  }
  const result = {
    currentRange: {
      start: currentRange.start.toISOString(),
      end: currentRange.end.toISOString(),
    },
    compareRange: {
      start: compareRange.start.toISOString(),
      end: compareRange.end.toISOString(),
    },
    overall: {
      current: {
        totalAmount: currentSummary.totalAmount,
        totalRows: currentSummary.totalRows,
        avgAmount: currentSummary.avgAmount,
        avgDailyAmount: currentSummary.avgDailyAmount,
        totalQuantity: currentSummary.totalQuantity,
      },
      compare: {
        totalAmount: compareSummary.totalAmount,
        totalRows: compareSummary.totalRows,
        avgAmount: compareSummary.avgAmount,
        avgDailyAmount: compareSummary.avgDailyAmount,
        totalQuantity: compareSummary.totalQuantity,
      },
      changes: {
        totalAmount: amountChange,
        totalRows: rowsChange,
        avgAmount: avgChange,
        avgDailyAmount: dailyChange,
      },
    },
    significantChanges,
  };
  if (output) {
    const outputPath = path.resolve(output);
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    logSuccess(`对比结果已保存到: ${outputPath}`);
  }
  return result;
}

module.exports = compareCommand;
