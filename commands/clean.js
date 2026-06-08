const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');
const inquirer = require('inquirer');
const DataStore = require('../lib/data-store');
const {
  logInfo,
  logSuccess,
  logWarning,
  logError,
  formatNumber,
  formatCurrency,
  ensureDir,
} = require('../lib/utils');

function loadStoreFromInput(input, columns) {
  const store = new DataStore();
  if (fs.existsSync(input)) {
    const ext = path.extname(input).toLowerCase();
    if (ext === '.json') {
      const data = JSON.parse(fs.readFileSync(input, 'utf-8'));
      if (data.columns) store.columns = { ...store.columns, ...data.columns };
      if (data.data && data.data.rows) {
        for (const row of data.data.rows) {
          const original = { ...row };
          delete original._parsedDate;
          delete original._parsedAmount;
          delete original._parsedQuantity;
          delete original._channel;
          store.rows.push({
            ...original,
            _source: path.basename(input),
            _sourceIndex: store.rows.length,
            _original: original,
            _valid: true,
            _filtered: false,
          });
        }
      }
      store.stats.totalRows = store.rows.length;
    } else {
      store.loadFromFile(input, columns);
    }
  } else {
    throw new Error(`文件不存在: ${input}`);
  }
  if (columns) {
    if (columns.dateColumn) store.columns.dateColumn = columns.dateColumn;
    if (columns.amountColumn) store.columns.amountColumn = columns.amountColumn;
    if (columns.channelColumn) store.columns.channelColumn = columns.channelColumn;
    if (columns.quantityColumn) store.columns.quantityColumn = columns.quantityColumn;
  }
  return store;
}

async function cleanCommand(input, options, cmd) {
  const {
    dateColumn,
    amountColumn,
    channelColumn,
    quantityColumn,
    keepInvalidDates,
    keepInvalidAmounts,
    filterZero,
    filterNegative,
    noMerge,
    preview,
    output,
    interactive,
  } = options;
  if (!input && !interactive) {
    logError('请指定输入文件路径');
    console.log('示例: report clean data.json --output cleaned.json');
    process.exit(1);
  }
  let inputFile = input;
  if (interactive && !inputFile) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: '请输入要清洗的数据文件路径:',
        validate: (val) => fs.existsSync(val) || '文件不存在',
      },
    ]);
    inputFile = answers.input;
  }
  let store;
  try {
    store = loadStoreFromInput(inputFile, {
      dateColumn,
      amountColumn,
      channelColumn,
      quantityColumn,
    });
  } catch (err) {
    logError(`加载数据失败: ${err.message}`);
    process.exit(1);
  }
  if (!store.columns.dateColumn || !store.columns.amountColumn) {
    logError('缺少必要的列配置，请先使用 import 命令导入数据');
    process.exit(1);
  }
  logInfo(`开始清洗数据，共 ${chalk.cyan(formatNumber(store.rows.length))} 行`);
  const cleanResult = store.clean({
    filterInvalidDates: !keepInvalidDates,
    filterInvalidAmounts: !keepInvalidAmounts,
    filterZeroAmount: filterZero,
    filterNegativeAmount: filterNegative,
    mergeChannels: !noMerge,
  });
  console.log(`\n${chalk.cyan('=== 清洗结果 ===')}`);
  const resultTable = new Table({
    head: [chalk.white('清洗项'), chalk.white('数量'), chalk.white('说明')],
    style: { head: [], border: [] },
    colWidths: [20, 15, 40],
  });
  resultTable.push(
    ['原始行数', formatNumber(store.stats.totalRows), '导入的总数据行数'],
  );
  if (cleanResult.invalidDateCount > 0) {
    resultTable.push([
      chalk.red('无效日期'),
      chalk.red(formatNumber(cleanResult.invalidDateCount)),
      keepInvalidDates ? '保留' : '已过滤',
    ]);
  }
  if (cleanResult.invalidAmountCount > 0) {
    resultTable.push([
      chalk.red('无效金额'),
      chalk.red(formatNumber(cleanResult.invalidAmountCount)),
      keepInvalidAmounts ? '保留' : '已过滤',
    ]);
  }
  if (cleanResult.zeroAmountCount > 0) {
    resultTable.push([
      chalk.yellow('零金额'),
      chalk.yellow(formatNumber(cleanResult.zeroAmountCount)),
      filterZero ? '已过滤' : '保留',
    ]);
  }
  if (cleanResult.negativeAmountCount > 0) {
    resultTable.push([
      chalk.yellow('负金额'),
      chalk.yellow(formatNumber(cleanResult.negativeAmountCount)),
      filterNegative ? '已过滤' : '保留',
    ]);
  }
  if (cleanResult.channelsMerged > 0) {
    resultTable.push([
      chalk.green('渠道合并'),
      chalk.green(formatNumber(cleanResult.channelsMerged)),
      noMerge ? '未启用' : `合并了 ${cleanResult.channelsMerged} 个同义词渠道`,
    ]);
  }
  resultTable.push([
    chalk.bold('有效行数'),
    chalk.bold.green(formatNumber(cleanResult.validRows)),
    `占比 ${((cleanResult.validRows / store.stats.totalRows) * 100).toFixed(1)}%`,
  ]);
  console.log(resultTable.toString());
  if (store.columns.channelColumn && cleanResult.channelsMerged > 0 && !noMerge) {
    const channels = new Map();
    for (const row of store.getValidRows()) {
      const name = row[store.columns.channelColumn] || '未分类';
      channels.set(name, (channels.get(name) || 0) + 1);
    }
    console.log(`\n${chalk.cyan('=== 渠道统计 ===')}`);
    const channelTable = new Table({
      head: [chalk.white('渠道名称'), chalk.white('订单数'), chalk.white('占比')],
      style: { head: [], border: [] },
    });
    const total = cleanResult.validRows;
    const sortedChannels = Array.from(channels.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sortedChannels.slice(0, 10)) {
      channelTable.push([
        name,
        formatNumber(count),
        `${((count / total) * 100).toFixed(1)}%`,
      ]);
    }
    if (sortedChannels.length > 10) {
      channelTable.push([
        chalk.gray(`其他 ${sortedChannels.length - 10} 个渠道`),
        chalk.gray(formatNumber(sortedChannels.slice(10).reduce((s, c) => s + c[1], 0))),
        chalk.gray(`${((sortedChannels.slice(10).reduce((s, c) => s + c[1], 0) / total) * 100).toFixed(1)}%`),
      ]);
    }
    console.log(channelTable.toString());
  }
  if (preview) {
    console.log(`\n${chalk.cyan('=== 清洗后数据预览（前 10 行）===')}`);
    const validRows = store.getValidRows();
    const previewTable = new Table({
      head: [
        chalk.white('#'),
        chalk.white('日期'),
        chalk.white('金额'),
        store.columns.channelColumn ? chalk.white('渠道') : null,
      ].filter(Boolean),
      style: { head: [], border: [] },
    });
    validRows.slice(0, 10).forEach((row, idx) => {
      const rowData = [
        idx + 1,
        row._parsedDate ? row._parsedDate.toISOString().split('T')[0] : '-',
        formatCurrency(row._parsedAmount),
        store.columns.channelColumn ? (row[store.columns.channelColumn] || '-') : null,
      ].filter(Boolean);
      previewTable.push(rowData);
    });
    console.log(previewTable.toString());
  }
  const result = {
    columns: store.columns,
    stats: {
      ...store.stats,
      cleanDetails: cleanResult,
    },
    data: store.toJSON(),
  };
  if (output) {
    const outputPath = path.resolve(output);
    ensureDir(path.dirname(outputPath));
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.json') {
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    } else if (ext === '.csv') {
      const validRows = store.getValidRows();
      const headers = ['日期', '金额'];
      if (store.columns.channelColumn) headers.push('渠道');
      if (store.columns.quantityColumn) headers.push('数量');
      const lines = [headers.join(',')];
      for (const row of validRows) {
        const line = [
          row._parsedDate ? row._parsedDate.toISOString().split('T')[0] : '',
          row._parsedAmount || '',
        ];
        if (store.columns.channelColumn) line.push(row[store.columns.channelColumn] || '');
        if (store.columns.quantityColumn) line.push(row._parsedQuantity || '');
        lines.push(line.join(','));
      }
      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
    } else {
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    }
    logSuccess(`清洗结果已保存到: ${outputPath}`);
  }
  return result;
}

module.exports = { cleanCommand, loadStoreFromInput };
