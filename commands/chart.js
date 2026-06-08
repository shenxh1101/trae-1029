const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');
const asciichart = require('asciichart');
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
  formatDateKey,
  getWeekRange,
  ensureDir,
  parseDate,
  calculateChange,
} = require('../lib/utils');

function generateBarChart(values, labels, maxWidth = 50) {
  const maxValue = Math.max(...values, 1);
  const lines = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const barLength = Math.round((value / maxValue) * maxWidth);
    const bar = '█'.repeat(barLength) + '░'.repeat(maxWidth - barLength);
    lines.push(`${labels[i].padEnd(12)} ${chalk.green(bar)} ${formatCurrency(value)}`);
  }
  return lines.join('\n');
}

function generateHorizontalBar(values, labels, title, maxWidth = 40) {
  const maxValue = Math.max(...values, 1);
  const lines = [];
  lines.push(chalk.bold(title));
  lines.push('');
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const percentage = (value / maxValue) * 100;
    const barLength = Math.round((value / maxValue) * maxWidth);
    const label = labels[i].length > 10 ? labels[i].slice(0, 9) + '…' : labels[i];
    const bar = chalk.green('█'.repeat(barLength)) + chalk.gray('░'.repeat(maxWidth - barLength));
    lines.push(`${label.padEnd(10)} ${bar} ${formatCurrency(value)} (${percentage.toFixed(0)}%)`);
  }
  return lines.join('\n');
}

async function chartCommand(input, options, cmd) {
  const {
    type = 'line',
    metric = 'amount',
    groupBy = 'date',
    startDate,
    endDate,
    date,
    rangeType = 'all',
    top = 10,
    width = 80,
    height = 20,
    output,
    interactive,
    noColor,
  } = options;
  if (!input && !interactive) {
    logError('请指定输入文件路径');
    console.log('示例: report chart cleaned.json --type line --metric amount');
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
        message: '选择图表类型:',
        choices: ['line', 'bar', 'horizontal', 'pie'],
        default: 0,
      },
      {
        type: 'list',
        name: 'metric',
        message: '选择统计指标:',
        choices: ['amount', 'quantity', 'orders'],
        default: 0,
      },
      {
        type: 'list',
        name: 'groupBy',
        message: '选择分组方式:',
        choices: ['date', 'channel'],
        default: 0,
      },
    ]);
    inputFile = answers.input;
    options.type = answers.type;
    options.metric = answers.metric;
    options.groupBy = answers.groupBy;
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
  if (rangeType === 'weekly') {
    const baseDate = date ? parseDate(date) : new Date();
    dateRange = getWeekRange(baseDate);
  } else if (rangeType === 'custom' || startDate || endDate) {
    const start = startDate ? parseDate(startDate) : null;
    const end = endDate ? parseDate(endDate) : null;
    if (start && end) dateRange = { start, end };
  }
  let dataPoints = [];
  let labels = [];
  let title = '';
  let sourceData = [];
  if (groupBy === 'date') {
    const dailyData = store.groupByDate(dateRange);
    sourceData = dailyData;
    if (dailyData.length === 0) {
      logWarning('当前筛选条件下没有可用的日期数据，请调整日期范围后重试');
      if (output) {
        logWarning('没有数据，已跳过导出 SVG 文件');
      }
      return { hasData: false, message: '没有可用的日期数据' };
    }
    for (const day of dailyData) {
      if (metric === 'amount') dataPoints.push(day.totalAmount);
      else if (metric === 'quantity') dataPoints.push(day.totalQuantity);
      else if (metric === 'orders') dataPoints.push(day.rowCount);
      labels.push(format(day.date, 'MM-dd', { locale: zhCN }));
    }
    const metricName = metric === 'amount' ? '销售额' : metric === 'quantity' ? '销量' : '订单数';
    title = `每日${metricName}趋势（${dailyData.length} 天）`;
  } else if (groupBy === 'channel') {
    const channelData = store.groupByChannel(dateRange).slice(0, top);
    sourceData = channelData;
    if (channelData.length === 0) {
      logWarning('当前筛选条件下没有可用的渠道数据，请调整筛选条件后重试');
      if (output) {
        logWarning('没有数据，已跳过导出 SVG 文件');
      }
      return { hasData: false, message: '没有可用的渠道数据' };
    }
    for (const ch of channelData) {
      if (metric === 'amount') dataPoints.push(ch.totalAmount);
      else if (metric === 'quantity') dataPoints.push(ch.totalQuantity);
      else if (metric === 'orders') dataPoints.push(ch.rowCount);
      labels.push(ch.channel);
    }
    const metricName = metric === 'amount' ? '销售额' : metric === 'quantity' ? '销量' : '订单数';
    title = `渠道${metricName}分布（TOP${channelData.length}）`;
  }
  console.log(`\n${chalk.cyan('='.repeat(width))}`);
  console.log(chalk.bold.cyan(`【${title}】`));
  console.log(chalk.cyan('='.repeat(width)));
  console.log('');
  if (type === 'line') {
    const config = {
      height: height,
      width: width,
      format: (v) => formatCurrency(v),
    };
    if (dataPoints.length === 1) {
      const singleValue = dataPoints[0];
      const singleLabel = labels[0];
      console.log(chalk.cyan(`📌 单日数据点: ${singleLabel}`));
      console.log(chalk.green(`   数值: ${formatCurrency(singleValue)}`));
      console.log('');
      const barWidth = Math.min(width - 30, 40);
      const max = singleValue * 1.5;
      const barLength = Math.round((singleValue / max) * barWidth);
      console.log(`${' '.repeat(10)} ${chalk.green('█'.repeat(barLength))} ${formatCurrency(singleValue)}`);
      console.log(`${' '.repeat(10)} ${chalk.gray('└' + '─'.repeat(barWidth) + '┘')}`);
      console.log(`${' '.repeat(10)} ${singleLabel.padEnd(barWidth)}`);
    } else {
      if (noColor) {
        console.log(asciichart.plot(dataPoints, { ...config, colors: undefined }));
      } else {
        console.log(asciichart.plot(dataPoints, { ...config, colors: [asciichart.green] }));
      }
      const stride = Math.max(1, Math.floor(labels.length / 10));
      const xLabels = labels.map((l, i) => i % stride === 0 ? l : '').join('  ');
      console.log(`\n${' '.repeat(10)}${xLabels}`);
    }
  } else if (type === 'bar' || type === 'horizontal') {
    if (groupBy === 'channel' || dataPoints.length <= 15) {
      console.log(generateHorizontalBar(dataPoints, labels, title, Math.min(width - 30, 50)));
    } else {
      console.log(generateBarChart(dataPoints, labels, Math.min(width - 30, 60)));
    }
  } else if (type === 'pie') {
    console.log(chalk.yellow('提示：ASCII 饼图使用横向百分比表示'));
    console.log('');
    const total = dataPoints.reduce((a, b) => a + b, 0);
    const pieTable = new Table({
      head: [chalk.white('项目'), chalk.white('数值'), chalk.white('占比'), chalk.white('可视化')],
      style: { head: [], border: [] },
      colWidths: [15, 15, 10, 30],
    });
    for (let i = 0; i < dataPoints.length; i++) {
      const value = dataPoints[i];
      const percentage = total > 0 ? (value / total) * 100 : 0;
      const barLength = Math.round(percentage / 5);
      const colors = [
        chalk.green, chalk.cyan, chalk.yellow, chalk.magenta, chalk.blue,
        chalk.red, chalk.gray, chalk.white
      ];
      const color = colors[i % colors.length];
      const bar = color('█'.repeat(barLength)) + chalk.gray('░'.repeat(20 - barLength));
      pieTable.push([
        labels[i],
        formatCurrency(value),
        `${percentage.toFixed(1)}%`,
        bar,
      ]);
    }
    console.log(pieTable.toString());
  }
  console.log('');
  console.log(chalk.cyan('='.repeat(width)));
  if (dataPoints.length > 1) {
    const first = dataPoints[0];
    const last = dataPoints[dataPoints.length - 1];
    const change = calculateChange(last, first);
    const min = Math.min(...dataPoints);
    const max = Math.max(...dataPoints);
    const avg = dataPoints.reduce((a, b) => a + b, 0) / dataPoints.length;
    const statsTable = new Table({
      head: [chalk.white('统计项'), chalk.white('数值')],
      style: { head: [], border: [] },
      colWidths: [20, 30],
    });
    statsTable.push(
      ['数据点数', formatNumber(dataPoints.length)],
      ['最小值', formatCurrency(min)],
      ['最大值', formatCurrency(max)],
      ['平均值', formatCurrency(avg)],
      ['首尾变化', (change > 0 ? '+' : '') + `${(change * 100).toFixed(1)}%`],
    );
    console.log('');
    console.log(chalk.bold('📊 数据统计'));
    console.log(statsTable.toString());
  }
  const result = {
    title,
    type,
    metric,
    groupBy,
    labels,
    dataPoints,
    stats: {
      min: Math.min(...dataPoints),
      max: Math.max(...dataPoints),
      avg: dataPoints.reduce((a, b) => a + b, 0) / dataPoints.length,
      count: dataPoints.length,
    },
  };
  if (output) {
    const outputPath = path.resolve(output);
    ensureDir(path.dirname(outputPath));
    if (outputPath.endsWith('.svg')) {
      const svgContent = generateSVG(dataPoints, labels, title, type, width, height);
      fs.writeFileSync(outputPath, svgContent, 'utf-8');
    } else {
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    }
    logSuccess(`图表数据已保存到: ${outputPath}`);
  }
  return result;
}

function generateSVG(dataPoints, labels, title, type, width, height) {
  if (!dataPoints || dataPoints.length === 0) {
    return generateEmptySVG(title, width, height, '没有可用数据');
  }
  const validPoints = dataPoints.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (validPoints.length === 0) {
    return generateEmptySVG(title, width, height, '没有有效数值');
  }
  const padding = { top: 40, right: 40, bottom: 60, left: 80 };
  const chartWidth = Math.max(width - padding.left - padding.right, 100);
  const chartHeight = Math.max(height * 5 - padding.top - padding.bottom, 100);
  const maxValueRaw = Math.max(...validPoints);
  const maxValue = isFinite(maxValueRaw) && maxValueRaw > 0 ? maxValueRaw * 1.1 : 100;
  const minValue = 0;
  let paths = '';
  if (type === 'line') {
    if (dataPoints.length === 1) {
      const v = dataPoints[0];
      const x = padding.left + chartWidth / 2;
      const y = padding.top + chartHeight - ((v - minValue) / (maxValue - minValue)) * chartHeight;
      paths = `<circle cx="${x}" cy="${y}" r="8" fill="#4CAF50"/>`;
      paths += `<text x="${x}" y="${y - 15}" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">${formatCurrency(v)}</text>`;
    } else {
      const points = dataPoints.map((v, i) => {
        const x = padding.left + (i / (dataPoints.length - 1)) * chartWidth;
        const yVal = (v - minValue) / (maxValue - minValue);
        const y = padding.top + chartHeight - (isFinite(yVal) ? yVal : 0.5) * chartHeight;
        return `${x},${y}`;
      });
      paths = `<polyline points="${points.join(' ')}" fill="none" stroke="#4CAF50" stroke-width="2"/>`;
      paths += points.map((p, i) => {
        const [x, y] = p.split(',');
        return `<circle cx="${x}" cy="${y}" r="4" fill="#4CAF50"/><title>${labels[i]}: ${formatCurrency(dataPoints[i])}</title>`;
      }).join('');
    }
  } else if (type === 'bar' || type === 'horizontal') {
    const barWidth = chartWidth / dataPoints.length * 0.7;
    const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336', '#00BCD4', '#8BC34A', '#FF5722'];
    paths = dataPoints.map((v, i) => {
      const x = padding.left + (i / dataPoints.length) * chartWidth + (chartWidth / dataPoints.length - barWidth) / 2;
      const yRatio = ((v - minValue) / (maxValue - minValue));
      const barHeight = isFinite(yRatio) ? yRatio * chartHeight : 0;
      const y = padding.top + chartHeight - barHeight;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${colors[i % colors.length]}" rx="3"><title>${labels[i]}: ${formatCurrency(v)}</title></rect>`;
    }).join('');
  }
  const xLabels = labels.map((label, i) => {
    const x = padding.left + (i / Math.max(dataPoints.length - 1, 1)) * chartWidth;
    return `<text x="${x}" y="${padding.top + chartHeight + 25}" text-anchor="middle" font-size="11" fill="#666">${label}</text>`;
  }).join('');
  const yTicks = 5;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const value = minValue + (maxValue - minValue) * (i / yTicks);
    const y = padding.top + chartHeight - (i / yTicks) * chartHeight;
    const displayValue = isFinite(value) ? Math.round(value).toLocaleString() : '0';
    return `<text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#666">${displayValue}</text>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height * 5}" viewBox="0 0 ${width} ${height * 5}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${width / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">${title}</text>
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#ddd" stroke-width="1"/>
  <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}" stroke="#ddd" stroke-width="1"/>
  ${yLabels}
  ${xLabels}
  ${paths}
</svg>`;
}

function generateEmptySVG(title, width, height, message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height * 5}" viewBox="0 0 ${width} ${height * 5}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${width / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">${title}</text>
  <text x="${width / 2}" y="${height * 2.5}" text-anchor="middle" font-size="14" fill="#999">${message}</text>
</svg>`;
}

module.exports = chartCommand;
module.exports.generateSVG = generateSVG;
