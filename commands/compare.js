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
  getChangeInfo,
  formatChangeForJSON,
  CHANGE_TYPE,
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
  const amountChangeInfo = getChangeInfo(currentSummary.totalAmount, compareSummary.totalAmount);
  const rowsChangeInfo = getChangeInfo(currentSummary.totalRows, compareSummary.totalRows);
  const avgChangeInfo = getChangeInfo(currentSummary.avgAmount, compareSummary.avgAmount);
  const dailyChangeInfo = getChangeInfo(currentSummary.avgDailyAmount, compareSummary.avgDailyAmount);
  overallTable.push(
    ['总销售额', formatCurrency(currentSummary.totalAmount), formatCurrency(compareSummary.totalAmount), amountChangeInfo.display],
    ['订单数', formatNumber(currentSummary.totalRows), formatNumber(compareSummary.totalRows), rowsChangeInfo.display],
    ['客单价', formatCurrency(currentSummary.avgAmount), formatCurrency(compareSummary.avgAmount), avgChangeInfo.display],
    ['日均销售额', formatCurrency(currentSummary.avgDailyAmount), formatCurrency(compareSummary.avgDailyAmount), dailyChangeInfo.display],
  );
  let qtyChangeInfo = null;
  if (currentSummary.totalQuantity > 0 || compareSummary.totalQuantity > 0) {
    qtyChangeInfo = getChangeInfo(currentSummary.totalQuantity, compareSummary.totalQuantity);
    overallTable.push(['总销量', formatNumber(currentSummary.totalQuantity), formatNumber(compareSummary.totalQuantity), qtyChangeInfo.display]);
  }
  console.log(overallTable.toString());
  let mergedChannels = [];
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
    mergedChannels = Array.from(allChannels).map(channel => {
      const curr = currentChannels.find(c => c.channel === channel) || { totalAmount: 0, totalQuantity: 0, rowCount: 0 };
      const prev = compareChannels.find(c => c.channel === channel) || { totalAmount: 0, totalQuantity: 0, rowCount: 0 };
      const changeInfo = getChangeInfo(curr.totalAmount, prev.totalAmount);
      return {
        channel,
        currentAmount: curr.totalAmount,
        compareAmount: prev.totalAmount,
        changeInfo,
      };
    }).sort((a, b) => b.currentAmount - a.currentAmount);
    mergedChannels.slice(0, 10).forEach((ch, idx) => {
      const share = currentSummary.totalAmount > 0 ? ch.currentAmount / currentSummary.totalAmount : 0;
      channelTable.push([
        idx + 1,
        ch.channel,
        formatCurrency(ch.currentAmount),
        formatCurrency(ch.compareAmount),
        ch.changeInfo.display,
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
      const changeInfo = prev
        ? getChangeInfo(curr.totalAmount, prev.totalAmount)
        : { display: chalk.gray('无同期数据'), displayShort: '-' };
      dayTable.push([
        curr.dateKey,
        format(curr.date, 'EEE', { locale: zhCN }),
        formatCurrency(curr.totalAmount),
        prev ? formatCurrency(prev.totalAmount) : '-',
        changeInfo.display,
      ]);
    }
    console.log(dayTable.toString());
  }
  const significantChanges = [];
  if (amountChangeInfo.type === CHANGE_TYPE.NORMAL && Math.abs(amountChangeInfo.value) > 0.2) {
    significantChanges.push({
      type: '整体销售额',
      change: amountChangeInfo.value,
      changeDescription: amountChangeInfo.displayShort,
      message: `整体销售额${amountChangeInfo.value > 0 ? '增长' : '下降'} ${formatPercent(Math.abs(amountChangeInfo.value), 1)}`,
    });
  } else if (amountChangeInfo.type === CHANGE_TYPE.NEW) {
    significantChanges.push({
      type: '整体销售额',
      change: null,
      changeDescription: '新增',
      message: '本期有销售额，上期无数据',
    });
  }
  if (byChannel && store.columns.channelColumn) {
    const currentChannels = store.groupByChannel(currentRange);
    const compareMap = new Map(store.groupByChannel(compareRange).map(c => [c.channel, c]));
    for (const ch of currentChannels) {
      const prev = compareMap.get(ch.channel);
      const changeInfo = prev ? getChangeInfo(ch.totalAmount, prev.totalAmount) : getChangeInfo(ch.totalAmount, 0);
      const isSignificant = (changeInfo.type === CHANGE_TYPE.NORMAL && Math.abs(changeInfo.value) > 0.3) ||
                            (changeInfo.type === CHANGE_TYPE.NEW && ch.totalAmount > currentSummary.totalAmount * 0.05);
      if (isSignificant && ch.totalAmount > currentSummary.totalAmount * 0.05) {
        const message = changeInfo.type === CHANGE_TYPE.NEW
          ? `${ch.channel} 渠道为新增渠道，本期销售额 ${formatCurrency(ch.totalAmount)}`
          : `${ch.channel} 渠道销售额${changeInfo.value > 0 ? '增长' : '下降'} ${formatPercent(Math.abs(changeInfo.value), 1)}`;
        significantChanges.push({
          type: '渠道',
          channel: ch.channel,
          change: changeInfo.value,
          changeDescription: changeInfo.displayShort,
          message,
        });
      }
    }
  }
  if (significantChanges.length > 0) {
    console.log(`\n${chalk.bold.red('四、显著变化提醒')}`);
    for (const item of significantChanges) {
      const changeValue = item.change;
      const icon = changeValue === null ? '🆕' : changeValue > 0.5 ? '📈' : changeValue > 0.2 ? '📊' : '📉';
      const severity = changeValue === null ? chalk.green : Math.abs(changeValue) > 0.5 ? chalk.red : Math.abs(changeValue) > 0.3 ? chalk.yellow : chalk.blue;
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
        totalAmount: formatChangeForJSON(amountChangeInfo),
        totalRows: formatChangeForJSON(rowsChangeInfo),
        avgAmount: formatChangeForJSON(avgChangeInfo),
        avgDailyAmount: formatChangeForJSON(dailyChangeInfo),
      },
    },
    significantChanges: significantChanges.map(sc => ({
      ...sc,
      change: sc.change !== null && isFinite(sc.change) ? sc.change : null,
    })),
  };
  if (qtyChangeInfo) {
    result.overall.changes.totalQuantity = formatChangeForJSON(qtyChangeInfo);
  }
  if (byChannel && store.columns.channelColumn) {
    result.channels = mergedChannels.map(mc => ({
      channel: mc.channel,
      currentAmount: mc.currentAmount,
      compareAmount: mc.compareAmount,
      change: formatChangeForJSON(mc.changeInfo),
    }));
  }
  if (byDay && type === 'weekly') {
    const currentDaily = store.groupByDate(currentRange);
    const compareDaily = store.groupByDate(compareRange);
    result.daily = currentDaily.map((curr, i) => {
      const prev = compareDaily[i];
      const changeInfo = prev
        ? getChangeInfo(curr.totalAmount, prev.totalAmount)
        : { type: CHANGE_TYPE.NO_PREVIOUS, value: null, displayShort: '-' };
      return {
        date: curr.dateKey,
        currentAmount: curr.totalAmount,
        compareAmount: prev ? prev.totalAmount : 0,
        change: formatChangeForJSON(changeInfo),
      };
    });
  }
  if (output) {
    const outputPath = path.resolve(output);
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    logSuccess(`对比结果已保存到: ${outputPath}`);
  }
  return result;
}

module.exports = compareCommand;
