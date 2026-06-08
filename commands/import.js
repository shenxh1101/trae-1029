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
  detectColumns
} = require('../lib/utils');

async function importCommand(files, options, cmd) {
  const {
    dateColumn,
    amountColumn,
    channelColumn,
    quantityColumn,
    preview,
    interactive,
    output,
    config,
  } = options;
  if (files.length === 0 && !interactive) {
    logError('请指定要导入的文件路径');
    console.log('示例: report import data1.csv data2.xlsx');
    process.exit(1);
  }
  let importFiles = [...files];
  if (interactive) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'files',
        message: '请输入要导入的文件路径（多个文件用空格分隔）:',
        filter: (input) => input.trim().split(/\s+/).filter(f => f),
        validate: (input) => input.length > 0 || '至少需要一个文件',
      },
    ]);
    importFiles = answers.files;
  }
  const validFiles = [];
  for (const file of importFiles) {
    if (!fs.existsSync(file)) {
      logWarning(`文件不存在: ${file}，已跳过`);
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    if (!['.csv', '.xlsx', '.xls', '.json'].includes(ext)) {
      logWarning(`不支持的文件格式: ${ext}，已跳过`);
      continue;
    }
    validFiles.push(file);
  }
  if (validFiles.length === 0) {
    logError('没有可导入的有效文件');
    process.exit(1);
  }
  const store = new DataStore();
  for (const file of validFiles) {
    try {
      const count = store.loadFromFile(file, {
        dateColumn,
        amountColumn,
        channelColumn,
        quantityColumn,
      });
      logSuccess(`已导入 ${chalk.bold(path.basename(file))}，共 ${chalk.cyan(formatNumber(count))} 行数据`);
    } catch (err) {
      logError(`导入文件 ${file} 失败: ${err.message}`);
    }
  }
  if (store.rows.length === 0) {
    logError('未导入任何数据');
    process.exit(1);
  }
  if (!store.columns.dateColumn || !store.columns.amountColumn) {
    const headers = Object.keys(store.rows[0]._original);
    logWarning('未能自动识别日期列或金额列，请手动指定');
    console.log(`\n${chalk.underline('可用列名:')}`);
    console.log(headers.join(', '));
    if (interactive) {
      const columnAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'dateColumn',
          message: '请选择日期列:',
          choices: headers,
          default: store.columns.dateColumn || 0,
        },
        {
          type: 'list',
          name: 'amountColumn',
          message: '请选择金额列:',
          choices: headers,
          default: store.columns.amountColumn || 1,
        },
        {
          type: 'list',
          name: 'channelColumn',
          message: '请选择渠道列（可选）:',
          choices: ['(无)', ...headers],
          default: store.columns.channelColumn ? headers.indexOf(store.columns.channelColumn) + 1 : 0,
        },
      ]);
      store.columns.dateColumn = columnAnswers.dateColumn;
      store.columns.amountColumn = columnAnswers.amountColumn;
      store.columns.channelColumn = columnAnswers.channelColumn === '(无)' ? null : columnAnswers.channelColumn;
      for (const row of store.rows) {
        if (store.columns.channelColumn && columnAnswers.channelColumn !== '(无)') {
          row[store.columns.channelColumn] = columnAnswers.channelColumn;
        }
      }
    } else {
      console.log(`\n请使用参数指定列名:`);
      console.log(`  --date-column <列名>    指定日期列`);
      console.log(`  --amount-column <列名>  指定金额列`);
      console.log(`  --channel-column <列名> 指定渠道列（可选）`);
      process.exit(1);
    }
  }
  console.log(`\n${chalk.cyan('=== 列名映射 ===')}`);
  console.log(`日期列:   ${chalk.green(store.columns.dateColumn)}`);
  console.log(`金额列:   ${chalk.green(store.columns.amountColumn)}`);
  if (store.columns.channelColumn) {
    console.log(`渠道列:   ${chalk.green(store.columns.channelColumn)}`);
  }
  if (store.columns.quantityColumn) {
    console.log(`数量列:   ${chalk.green(store.columns.quantityColumn)}`);
  }
  if (preview) {
    console.log(`\n${chalk.cyan('=== 数据预览（前 10 行）===')}`);
    const previewTable = new Table({
      head: [
        chalk.white('#'),
        chalk.white(store.columns.dateColumn),
        chalk.white(store.columns.amountColumn),
        store.columns.channelColumn ? chalk.white(store.columns.channelColumn) : null,
        chalk.white('来源文件'),
      ].filter(Boolean),
      style: { head: [], border: [] },
    });
    const previewRows = store.rows.slice(0, 10);
    previewRows.forEach((row, idx) => {
      const rowData = [
        idx + 1,
        row[store.columns.dateColumn] || '-',
        formatCurrency(row[store.columns.amountColumn] ? Number(row[store.columns.amountColumn]) : null),
        store.columns.channelColumn ? (row[store.columns.channelColumn] || '-') : null,
        row._source,
      ].filter(Boolean);
      previewTable.push(rowData);
    });
    console.log(previewTable.toString());
    if (store.rows.length > 10) {
      console.log(chalk.gray(`... 还有 ${store.rows.length - 10} 行数据`));
    }
  }
  console.log(`\n${chalk.cyan('=== 导入统计 ===')}`);
  const statsTable = new Table({
    head: [chalk.white('指标'), chalk.white('数值')],
    style: { head: [], border: [] },
    colWidths: [20, 30],
  });
  statsTable.push(
    ['导入文件数', validFiles.length],
    ['总数据行数', formatNumber(store.stats.totalRows)],
  );
  for (const source of store.sourceFiles) {
    statsTable.push([`  ${source.name}`, formatNumber(source.rows)]);
  }
  console.log(statsTable.toString());
  const result = {
    columns: store.columns,
    sourceFiles: store.sourceFiles,
    stats: store.stats,
    data: store.toJSON(),
  };
  if (output) {
    const outputPath = path.resolve(output);
    require('../lib/utils').ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    logSuccess(`导入结果已保存到: ${outputPath}`);
  }
  if (config) {
    const Configstore = require('configstore');
    const pkg = require('../package.json');
    const conf = new Configstore(pkg.name);
    conf.set('lastImport', {
      files: validFiles,
      columns: store.columns,
      timestamp: new Date().toISOString(),
    });
    logSuccess('配置已保存，下次可直接使用');
  }
  return result;
}

module.exports = importCommand;
