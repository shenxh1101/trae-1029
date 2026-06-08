const fs = require('fs');
const path = require('path');
const {
  parseDate,
  parseNumber,
  normalizeChannelName,
  formatDateKey,
  logInfo,
  logWarning,
  isInDateRange,
  detectColumns
} = require('./utils');

class DataStore {
  constructor() {
    this.rows = [];
    this.columns = {
      dateColumn: null,
      amountColumn: null,
      channelColumn: null,
      quantityColumn: null,
    };
    this.sourceFiles = [];
    this.processed = false;
    this.stats = {
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      filteredRows: 0,
    };
  }

  loadFromFile(filePath, options = {}) {
    const ext = path.extname(filePath).toLowerCase();
    let data = [];
    if (ext === '.csv') {
      data = this._loadCSV(filePath);
    } else if (ext === '.xlsx' || ext === '.xls') {
      data = this._loadExcel(filePath);
    } else if (ext === '.json') {
      data = this._loadJSON(filePath);
    } else {
      throw new Error(`不支持的文件格式: ${ext}`);
    }
    if (data.length === 0) {
      throw new Error('文件为空或格式不正确');
    }
    const headers = Object.keys(data[0]);
    if (!this.columns.dateColumn || !this.columns.amountColumn) {
      const detected = detectColumns(headers, data.slice(0, 10));
      this.columns = { ...this.columns, ...detected };
    }
    if (options.dateColumn) this.columns.dateColumn = options.dateColumn;
    if (options.amountColumn) this.columns.amountColumn = options.amountColumn;
    if (options.channelColumn) this.columns.channelColumn = options.channelColumn;
    if (options.quantityColumn) this.columns.quantityColumn = options.quantityColumn;
    const baseRowCount = this.rows.length;
    for (let i = 0; i < data.length; i++) {
      const row = {
        ...data[i],
        _source: path.basename(filePath),
        _sourceIndex: baseRowCount + i,
        _original: { ...data[i] },
        _valid: true,
        _filtered: false,
      };
      this.rows.push(row);
    }
    this.sourceFiles.push({
      path: filePath,
      name: path.basename(filePath),
      rows: data.length,
    });
    this.stats.totalRows = this.rows.length;
    this.processed = false;
    return data.length;
  }

  _loadCSV(filePath) {
    const csv = require('csv-parser');
    const results = [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    if (lines.length === 0) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const values = this._parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] || '';
      });
      results.push(row);
    }
    return results;
  }

  _parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
  }

  _loadExcel(filePath) {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  }

  _loadJSON(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }

  clean(options = {}) {
    const {
      filterInvalidDates = true,
      filterInvalidAmounts = true,
      filterZeroAmount = false,
      filterNegativeAmount = false,
      mergeChannels = true,
      customFilter = null,
    } = options;
    let invalidDateCount = 0;
    let invalidAmountCount = 0;
    let zeroAmountCount = 0;
    let negativeAmountCount = 0;
    let customFiltered = 0;
    const channelMap = new Map();
    for (const row of this.rows) {
      row._parsedDate = null;
      row._parsedAmount = null;
      row._parsedQuantity = null;
      row._normalizedChannel = '';
      if (this.columns.dateColumn) {
        row._parsedDate = parseDate(row[this.columns.dateColumn]);
        if (filterInvalidDates && row._parsedDate === null) {
          row._valid = false;
          invalidDateCount++;
          continue;
        }
      }
      if (this.columns.amountColumn) {
        row._parsedAmount = parseNumber(row[this.columns.amountColumn]);
        if (filterInvalidAmounts && row._parsedAmount === null) {
          row._valid = false;
          invalidAmountCount++;
          continue;
        }
        if (filterZeroAmount && row._parsedAmount === 0) {
          row._valid = false;
          zeroAmountCount++;
          continue;
        }
        if (filterNegativeAmount && row._parsedAmount !== null && row._parsedAmount < 0) {
          row._valid = false;
          negativeAmountCount++;
          continue;
        }
      }
      if (this.columns.quantityColumn) {
        row._parsedQuantity = parseNumber(row[this.columns.quantityColumn]);
      }
      if (this.columns.channelColumn) {
        row._normalizedChannel = normalizeChannelName(row[this.columns.channelColumn]);
        if (mergeChannels && row._normalizedChannel) {
          if (!channelMap.has(row._normalizedChannel)) {
            channelMap.set(row._normalizedChannel, row[this.columns.channelColumn]);
          } else {
            row[this.columns.channelColumn] = channelMap.get(row._normalizedChannel);
          }
        }
      }
      if (customFilter && typeof customFilter === 'function') {
        if (!customFilter(row)) {
          row._filtered = true;
          customFiltered++;
          continue;
        }
      }
    }
    this.stats.validRows = this.rows.filter(r => r._valid && !r._filtered).length;
    this.stats.invalidRows = invalidDateCount + invalidAmountCount + zeroAmountCount + negativeAmountCount;
    this.stats.filteredRows = customFiltered;
    this.processed = true;
    return {
      invalidDateCount,
      invalidAmountCount,
      zeroAmountCount,
      negativeAmountCount,
      customFiltered,
      validRows: this.stats.validRows,
      channelsMerged: channelMap.size,
    };
  }

  getValidRows() {
    return this.rows.filter(r => r._valid && !r._filtered);
  }

  groupByDate(dateRange = null) {
    const groups = new Map();
    const validRows = this.getValidRows();
    for (const row of validRows) {
      if (!row._parsedDate) continue;
      if (dateRange && !isInDateRange(row._parsedDate, dateRange.start, dateRange.end)) continue;
      const key = formatDateKey(row._parsedDate);
      if (!groups.has(key)) {
        groups.set(key, {
          date: row._parsedDate,
          dateKey: key,
          totalAmount: 0,
          totalQuantity: 0,
          rowCount: 0,
          channels: new Map(),
        });
      }
      const group = groups.get(key);
      group.totalAmount += row._parsedAmount || 0;
      group.totalQuantity += row._parsedQuantity || 0;
      group.rowCount++;
      const channel = row[this.columns.channelColumn] || '未分类';
      if (!group.channels.has(channel)) {
        group.channels.set(channel, { amount: 0, quantity: 0, count: 0 });
      }
      const channelData = group.channels.get(channel);
      channelData.amount += row._parsedAmount || 0;
      channelData.quantity += row._parsedQuantity || 0;
      channelData.count++;
    }
    return Array.from(groups.values()).sort((a, b) => a.date - b.date);
  }

  groupByChannel(dateRange = null) {
    const groups = new Map();
    const validRows = this.getValidRows();
    for (const row of validRows) {
      if (dateRange && row._parsedDate && !isInDateRange(row._parsedDate, dateRange.start, dateRange.end)) continue;
      const channel = row[this.columns.channelColumn] || '未分类';
      if (!groups.has(channel)) {
        groups.set(channel, {
          channel,
          totalAmount: 0,
          totalQuantity: 0,
          rowCount: 0,
          firstDate: row._parsedDate,
          lastDate: row._parsedDate,
        });
      }
      const group = groups.get(channel);
      group.totalAmount += row._parsedAmount || 0;
      group.totalQuantity += row._parsedQuantity || 0;
      group.rowCount++;
      if (row._parsedDate) {
        if (!group.firstDate || row._parsedDate < group.firstDate) group.firstDate = row._parsedDate;
        if (!group.lastDate || row._parsedDate > group.lastDate) group.lastDate = row._parsedDate;
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  }

  getSummary(dateRange = null) {
    const validRows = this.getValidRows();
    let filteredRows = validRows;
    if (dateRange) {
      filteredRows = validRows.filter(r =>
        r._parsedDate && isInDateRange(r._parsedDate, dateRange.start, dateRange.end)
      );
    }
    const totalAmount = filteredRows.reduce((sum, r) => sum + (r._parsedAmount || 0), 0);
    const totalQuantity = filteredRows.reduce((sum, r) => sum + (r._parsedQuantity || 0), 0);
    const amounts = filteredRows.map(r => r._parsedAmount).filter(v => v !== null);
    const avgAmount = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
    const maxAmount = amounts.length > 0 ? Math.max(...amounts) : 0;
    const minAmount = amounts.length > 0 ? Math.min(...amounts) : 0;
    const dates = filteredRows.map(r => r._parsedDate).filter(d => d !== null);
    const dateGroups = new Map();
    for (const d of dates) {
      const key = formatDateKey(d);
      dateGroups.set(key, (dateGroups.get(key) || 0) + 1);
    }
    const dailyAmounts = new Map();
    for (const row of filteredRows) {
      if (!row._parsedDate) continue;
      const key = formatDateKey(row._parsedDate);
      dailyAmounts.set(key, (dailyAmounts.get(key) || 0) + (row._parsedAmount || 0));
    }
    const dailyValues = Array.from(dailyAmounts.values());
    const avgDailyAmount = dailyValues.length > 0
      ? dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length
      : 0;
    const channelGroups = this.groupByChannel(dateRange);
    return {
      totalRows: filteredRows.length,
      totalAmount,
      totalQuantity,
      avgAmount,
      maxAmount,
      minAmount,
      dateCount: dateGroups.size,
      avgDailyAmount,
      channelCount: channelGroups.length,
      topChannels: channelGroups.slice(0, 5),
      dates,
      dailyAmounts,
      dailyValues,
    };
  }

  detectAnomalies(dateRange = null, threshold = 0.3) {
    const dailyData = this.groupByDate(dateRange);
    if (dailyData.length < 3) return [];
    const anomalies = [];
    const amounts = dailyData.map(d => d.totalAmount);
    const validAmounts = amounts.filter(a => a > 0);
    if (validAmounts.length === 0) return [];
    const mean = validAmounts.reduce((a, b) => a + b, 0) / validAmounts.length;
    for (let i = 0; i < dailyData.length; i++) {
      const day = dailyData[i];
      if (day.totalAmount === 0) continue;
      const deviation = Math.abs(day.totalAmount - mean) / mean;
      if (deviation > threshold) {
        anomalies.push({
          type: 'daily_deviation',
          date: day.date,
          dateKey: day.dateKey,
          value: day.totalAmount,
          expected: mean,
          deviation,
          severity: deviation > 0.5 ? 'high' : 'medium',
          message: `${day.dateKey} 销售额 ${day.totalAmount > mean ? '高于' : '低于'}均值 ${(deviation * 100).toFixed(1)}%`,
        });
      }
    }
    const channelData = this.groupByChannel(dateRange);
    for (let i = 0; i < dailyData.length; i++) {
      const day = dailyData[i];
      for (const [channel, data] of day.channels.entries()) {
        const channelTotal = channelData.find(c => c.channel === channel);
        if (!channelTotal || channelTotal.totalAmount === 0) continue;
        const dailyShare = data.amount / channelTotal.totalAmount;
        const expectedShare = 1 / dailyData.length;
        const deviation = Math.abs(dailyShare - expectedShare) / expectedShare;
        if (deviation > threshold * 2 && dailyShare > 0.5) {
          anomalies.push({
            type: 'channel_concentration',
            date: day.date,
            dateKey: day.dateKey,
            channel,
            value: data.amount,
            share: dailyShare,
            severity: 'medium',
            message: `${day.dateKey} ${channel} 渠道销售额占比高达 ${(dailyShare * 100).toFixed(1)}%`,
          });
        }
      }
    }
    return anomalies.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  toJSON() {
    return {
      columns: this.columns,
      sourceFiles: this.sourceFiles,
      stats: this.stats,
      processed: this.processed,
      rows: this.getValidRows().map(r => ({
        ...r._original,
        _parsedDate: r._parsedDate ? formatDateKey(r._parsedDate) : null,
        _parsedAmount: r._parsedAmount,
        _parsedQuantity: r._parsedQuantity,
        _channel: r[this.columns.channelColumn] || null,
      })),
    };
  }
}

module.exports = DataStore;
