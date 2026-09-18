(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const numberFormatter = new Intl.NumberFormat("th-TH");

  const elements = {
    tabs: $$(".tab"),
    pasteInput: $("#pasteInput"),
    loadPasteButton: $("#loadPasteButton"),
    sampleButton: $("#sampleButton"),
    clearPasteButton: $("#clearPasteButton"),
    dataFileInput: $("#dataFileInput"),
    dataDropZone: $("#dataDropZone"),
    sourceOptions: $("#sourceOptions"),
    sourceStatus: $("#sourceStatus"),
    sourceMeta: $("#sourceMeta"),
    sheetSelect: $("#sheetSelect"),
    headerRowInput: $("#headerRowInput"),
    shopColumnSelect: $("#shopColumnSelect"),
    rulesFileInput: $("#rulesFileInput"),
    resetRulesButton: $("#resetRulesButton"),
    exportRulesButton: $("#exportRulesButton"),
    rulesStatus: $("#rulesStatus"),
    ruleCount: $("#ruleCount"),
    subRuleCount: $("#subRuleCount"),
    overlapCount: $("#overlapCount"),
    rulesPreviewBody: $("#rulesPreviewBody"),
    matchModeSelect: $("#matchModeSelect"),
    outputColumnInput: $("#outputColumnInput"),
    unmatchedInput: $("#unmatchedInput"),
    detailsCheckbox: $("#detailsCheckbox"),
    skipBlankCheckbox: $("#skipBlankCheckbox"),
    processButton: $("#processButton"),
    processMessage: $("#processMessage"),
    exportButton: $("#exportButton"),
    resultsSection: $("#resultsSection"),
    totalMetric: $("#totalMetric"),
    matchedMetric: $("#matchedMetric"),
    unmatchedMetric: $("#unmatchedMetric"),
    rateMetric: $("#rateMetric"),
    categorySummary: $("#categorySummary"),
    previewNote: $("#previewNote"),
    resultTableHead: $("#resultTableHead"),
    resultTableBody: $("#resultTableBody"),
    toast: $("#toast")
  };

  const state = {
    sourceName: "",
    sourceKind: "",
    sourceSheets: [],
    activeSheetIndex: 0,
    headers: [],
    rows: [],
    selectedColumnIndex: 0,
    ruleRows: ShopClassifier.DEFAULT_RULE_ROWS.map((row) => ({ ...row })),
    rules: ShopClassifier.DEFAULT_RULES,
    rulesSource: "shop.xlsx (ค่าเริ่มต้น)",
    result: null
  };

  const DATA_HEADER_ALIASES = new Set([
    "shop_name", "shop name", "shopname", "ชื่อร้าน", "ชื่อร้านค้า", "ร้านค้า", "shop"
  ]);

  const RULE_HEADERS = {
    result: new Set(["result", "shop result", "ผลลัพธ์", "ผลลัพท์", "ประเภท", "ผล"]),
    primary: new Set(["primary keywords", "primary keyword", "primarykeywords", "คำหลัก", "คีย์เวิร์ดหลัก", "keyword หลัก"]),
    sub: new Set(["sub keywords", "sub keyword", "subkeywords", "คำย่อย", "คีย์เวิร์ดย่อย", "keyword ย่อย"])
  };

  let toastTimer = null;

  function showToast(message, isError) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", Boolean(isError));
    elements.toast.classList.add("is-visible");
    toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
  }

  function setStatus(element, text, type) {
    element.textContent = text;
    element.className = `status status--${type || "muted"}`;
  }

  function normalizeHeader(value) {
    return ShopClassifier.normalizeText(value).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function isBlank(value) {
    return ShopClassifier.normalizeText(value) === "";
  }

  function trimTrailingBlankRows(matrix) {
    const rows = (matrix || []).map((row) => Array.isArray(row) ? row.slice() : [row]);
    let end = rows.length;
    while (end > 0 && rows[end - 1].every(isBlank)) end -= 1;
    return rows.slice(0, end);
  }

  function maxColumnCount(matrix) {
    return (matrix || []).reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 1), 0);
  }

  function firstNonBlankRow(matrix) {
    for (let index = 0; index < matrix.length; index += 1) {
      if ((matrix[index] || []).some((value) => !isBlank(value))) return index;
    }
    return 0;
  }

  function detectDataHeaderRow(matrix, sourceKind) {
    const scanLimit = Math.min(matrix.length, 25);
    for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
      const values = matrix[rowIndex] || [];
      if (values.some((value) => DATA_HEADER_ALIASES.has(normalizeHeader(value)))) return rowIndex + 1;
    }
    return sourceKind === "paste" ? 0 : firstNonBlankRow(matrix) + 1;
  }

  function makeUniqueHeaders(values, columnCount, noHeader) {
    const used = new Map();
    const headers = [];
    for (let index = 0; index < columnCount; index += 1) {
      let base;
      if (noHeader && columnCount === 1) base = "SHOP_NAME";
      else if (noHeader) base = `Column_${index + 1}`;
      else base = String(values[index] == null ? "" : values[index]).trim() || `Column_${index + 1}`;
      const key = normalizeHeader(base) || `column ${index + 1}`;
      const count = (used.get(key) || 0) + 1;
      used.set(key, count);
      headers.push(count === 1 ? base : `${base}_${count}`);
    }
    return headers;
  }

  function findShopColumn(headers) {
    let partial = -1;
    for (let index = 0; index < headers.length; index += 1) {
      const normalized = normalizeHeader(headers[index]);
      if (DATA_HEADER_ALIASES.has(normalized)) return index;
      if (partial < 0 && ((normalized.includes("shop") && normalized.includes("name")) || normalized.includes("ชื่อร้าน"))) partial = index;
    }
    return partial >= 0 ? partial : 0;
  }

  function resetResult() {
    state.result = null;
    elements.exportButton.disabled = true;
    elements.resultsSection.hidden = true;
    elements.processMessage.textContent = "";
  }

  function updateSourceFromSheet() {
    const sheet = state.sourceSheets[state.activeSheetIndex];
    if (!sheet) return;
    const matrix = sheet.rows;
    const requestedHeader = Math.max(0, Number(elements.headerRowInput.value || 0));
    const headerIndex = requestedHeader > 0 ? requestedHeader - 1 : -1;
    const columnCount = maxColumnCount(matrix);
    if (columnCount === 0) {
      state.headers = [];
      state.rows = [];
      elements.shopColumnSelect.innerHTML = "";
      setStatus(elements.sourceStatus, "ไม่พบข้อมูล", "danger");
      resetResult();
      return;
    }

    const headerValues = headerIndex >= 0 ? (matrix[headerIndex] || []) : [];
    state.headers = makeUniqueHeaders(headerValues, columnCount, headerIndex < 0);
    const dataStart = headerIndex >= 0 ? headerIndex + 1 : 0;
    state.rows = matrix.slice(dataStart).map((row) => {
      const normalizedRow = Array.from({ length: columnCount }, (_, index) => (row || [])[index] ?? "");
      return normalizedRow;
    });

    elements.shopColumnSelect.innerHTML = "";
    state.headers.forEach((header, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = header;
      elements.shopColumnSelect.appendChild(option);
    });
    state.selectedColumnIndex = findShopColumn(state.headers);
    elements.shopColumnSelect.value = String(state.selectedColumnIndex);

    const nonBlankShopRows = state.rows.filter((row) => !isBlank(row[state.selectedColumnIndex])).length;
    setStatus(elements.sourceStatus, `${numberFormatter.format(nonBlankShopRows)} ร้าน`, "success");
    elements.sourceMeta.textContent = `ไฟล์/แหล่งข้อมูล: ${state.sourceName} • Worksheet: ${sheet.name} • ${numberFormatter.format(state.rows.length)} แถวข้อมูล • ${state.headers.length} คอลัมน์`;
    elements.sourceOptions.hidden = false;
    resetResult();
  }

  function loadSourceSheets(sheets, sourceName, sourceKind) {
    const cleanedSheets = (sheets || [])
      .map((sheet, index) => ({
        name: String(sheet.name || `Sheet${index + 1}`),
        rows: trimTrailingBlankRows(sheet.rows || [])
      }))
      .filter((sheet) => sheet.rows.length > 0);
    if (cleanedSheets.length === 0) throw new Error("ไฟล์นี้ไม่มีข้อมูลที่อ่านได้");

    state.sourceName = sourceName;
    state.sourceKind = sourceKind;
    state.sourceSheets = cleanedSheets;
    state.activeSheetIndex = 0;

    elements.sheetSelect.innerHTML = "";
    cleanedSheets.forEach((sheet, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = sheet.name;
      elements.sheetSelect.appendChild(option);
    });
    elements.sheetSelect.disabled = cleanedSheets.length === 1;
    elements.headerRowInput.value = String(detectDataHeaderRow(cleanedSheets[0].rows, sourceKind));
    updateSourceFromSheet();
  }

  async function readInputFile(file) {
    const extension = (file.name.split(".").pop() || "").toLowerCase();
    if (extension === "xls") throw new Error("ไฟล์ .xls รุ่นเก่ายังไม่รองรับ กรุณาเปิดใน Excel แล้ว Save As เป็น .xlsx");
    if (extension === "xlsx") {
      const workbook = await MiniXLSX.readWorkbook(await file.arrayBuffer());
      return workbook.sheets;
    }
    if (["csv", "tsv", "txt"].includes(extension)) {
      const text = await file.text();
      const delimiter = extension === "tsv" ? "\t" : undefined;
      return [{ name: "Data", rows: MiniXLSX.parseDelimited(text, delimiter) }];
    }
    throw new Error("รองรับเฉพาะ .xlsx, .csv, .tsv และ .txt");
  }

  function switchTab(panelId) {
    elements.tabs.forEach((tab) => {
      const active = tab.dataset.tab === panelId;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$(".tab-panel").forEach((panel) => {
      const active = panel.id === panelId;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  function detectRuleHeader(matrix) {
    const scanLimit = Math.min(matrix.length, 30);
    for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
      const row = matrix[rowIndex] || [];
      let resultIndex = -1;
      let primaryIndex = -1;
      let subIndex = -1;
      row.forEach((value, index) => {
        const normalized = normalizeHeader(value);
        if (RULE_HEADERS.result.has(normalized)) resultIndex = index;
        if (RULE_HEADERS.primary.has(normalized)) primaryIndex = index;
        if (RULE_HEADERS.sub.has(normalized)) subIndex = index;
      });
      if (resultIndex >= 0 && primaryIndex >= 0) return { rowIndex, resultIndex, primaryIndex, subIndex };
    }
    return null;
  }

  function extractRulesFromSheets(sheets) {
    for (const sheet of sheets) {
      const matrix = trimTrailingBlankRows(sheet.rows || []);
      const header = detectRuleHeader(matrix);
      if (!header) continue;
      const rows = [];
      for (let rowIndex = header.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
        const row = matrix[rowIndex] || [];
        const result = row[header.resultIndex] ?? "";
        const primaryKeywords = row[header.primaryIndex] ?? "";
        const subKeywords = header.subIndex >= 0 ? (row[header.subIndex] ?? "") : "";
        if (isBlank(result) && isBlank(primaryKeywords)) continue;
        rows.push({ rowNumber: rowIndex + 1, result, primaryKeywords, subKeywords });
      }
      const prepared = ShopClassifier.prepareRules(rows);
      if (prepared.length > 0) return { rows, prepared, sheetName: sheet.name };
    }
    throw new Error("ไม่พบหัวตาราง Result และ Primary Keywords ในไฟล์กติกา");
  }

  function countRuleOverlaps(rules) {
    let overlaps = 0;
    for (let i = 0; i < rules.length; i += 1) {
      const keywordsA = new Set(rules[i].primary.map((keyword) => keyword.normalized));
      for (let j = i + 1; j < rules.length; j += 1) {
        if (rules[j].primary.some((keyword) => keywordsA.has(keyword.normalized))) overlaps += 1;
      }
    }
    return overlaps;
  }

  function renderRules() {
    elements.ruleCount.textContent = numberFormatter.format(state.rules.length);
    elements.subRuleCount.textContent = numberFormatter.format(state.rules.filter((rule) => rule.sub.length > 0).length);
    elements.overlapCount.textContent = numberFormatter.format(countRuleOverlaps(state.rules));
    setStatus(elements.rulesStatus, `${state.rules.length} กติกา`, "success");

    elements.rulesPreviewBody.innerHTML = "";
    state.rules.forEach((rule) => {
      const row = document.createElement("tr");
      [rule.result, rule.primaryKeywords, rule.subKeywords || "—"].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      elements.rulesPreviewBody.appendChild(row);
    });
  }

  function makeUniqueOutputHeader(base, used) {
    let name = String(base || "").trim() || "SHOP_RESULT";
    let key = normalizeHeader(name);
    let counter = 2;
    while (used.has(key)) {
      name = `${base}_${counter}`;
      key = normalizeHeader(name);
      counter += 1;
    }
    used.add(key);
    return name;
  }

  function processRows() {
    if (!state.rows.length || !state.headers.length) throw new Error("กรุณาใส่ข้อมูลร้านก่อน");
    state.selectedColumnIndex = Number(elements.shopColumnSelect.value || 0);
    const mode = elements.matchModeSelect.value;
    const unmatchedValue = elements.unmatchedInput.value.trim() || "ไม่พบเงื่อนไข";
    const includeDetails = elements.detailsCheckbox.checked;
    const skipBlank = elements.skipBlankCheckbox.checked;
    const usedHeaders = new Set(state.headers.map(normalizeHeader));
    const outputHeader = makeUniqueOutputHeader(elements.outputColumnInput.value.trim() || "SHOP_RESULT", usedHeaders);
    const resultHeaders = state.headers.slice();
    resultHeaders.push(outputHeader);

    let primaryHeader;
    let subHeader;
    let ruleRowHeader;
    let statusHeader;
    if (includeDetails) {
      primaryHeader = makeUniqueOutputHeader("MATCHED_PRIMARY_KEYWORD", usedHeaders);
      subHeader = makeUniqueOutputHeader("MATCHED_SUB_KEYWORD", usedHeaders);
      ruleRowHeader = makeUniqueOutputHeader("MATCHED_RULE_ROW", usedHeaders);
      statusHeader = makeUniqueOutputHeader("MATCH_STATUS", usedHeaders);
      resultHeaders.push(primaryHeader, subHeader, ruleRowHeader, statusHeader);
    }

    const resultRows = [];
    const classifications = [];
    for (const sourceRow of state.rows) {
      const shopName = sourceRow[state.selectedColumnIndex] ?? "";
      if (skipBlank && isBlank(shopName)) continue;
      const classification = ShopClassifier.classifyName(shopName, state.rules, { mode, unmatchedValue });
      const outputRow = sourceRow.slice();
      outputRow.push(classification.result);
      if (includeDetails) {
        outputRow.push(
          classification.primaryKeyword,
          classification.subKeyword,
          classification.ruleRow,
          classification.matched ? "MATCHED" : "UNMATCHED"
        );
      }
      resultRows.push(outputRow);
      classifications.push(classification);
    }
    if (resultRows.length === 0) throw new Error("ไม่มีแถวข้อมูลสำหรับประมวลผล");

    state.result = {
      headers: resultHeaders,
      rows: resultRows,
      classifications,
      summary: ShopClassifier.summarize(classifications),
      mode,
      unmatchedValue,
      outputHeader,
      processedAt: new Date()
    };
  }

  function displayValue(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toLocaleString("th-TH");
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return value == null ? "" : String(value);
  }

  function renderResults() {
    const result = state.result;
    if (!result) return;
    const summary = result.summary;
    const rate = summary.total ? (summary.matched / summary.total) * 100 : 0;
    elements.totalMetric.textContent = numberFormatter.format(summary.total);
    elements.matchedMetric.textContent = numberFormatter.format(summary.matched);
    elements.unmatchedMetric.textContent = numberFormatter.format(summary.unmatched);
    elements.rateMetric.textContent = `${rate.toFixed(rate >= 99.95 ? 0 : 1)}%`;

    elements.categorySummary.innerHTML = "";
    const maxCount = Math.max(1, ...summary.counts.map((item) => item.count));
    summary.counts.forEach((item) => {
      const wrapper = document.createElement("div");
      wrapper.className = "category-item";
      const label = document.createElement("div");
      label.className = "category-item__label";
      const name = document.createElement("div");
      name.className = "category-item__name";
      const nameText = document.createElement("span");
      nameText.textContent = item.result;
      const percent = document.createElement("span");
      percent.textContent = `${((item.count / summary.total) * 100).toFixed(1)}%`;
      name.append(nameText, percent);
      const bar = document.createElement("div");
      bar.className = "category-item__bar";
      const fill = document.createElement("div");
      fill.className = "category-item__fill";
      fill.style.width = `${(item.count / maxCount) * 100}%`;
      bar.appendChild(fill);
      label.append(name, bar);
      const count = document.createElement("div");
      count.className = "category-item__count";
      count.textContent = numberFormatter.format(item.count);
      wrapper.append(label, count);
      elements.categorySummary.appendChild(wrapper);
    });

    elements.resultTableHead.innerHTML = "";
    const headRow = document.createElement("tr");
    result.headers.forEach((header) => {
      const th = document.createElement("th");
      th.textContent = header;
      headRow.appendChild(th);
    });
    elements.resultTableHead.appendChild(headRow);

    elements.resultTableBody.innerHTML = "";
    const previewLimit = Math.min(120, result.rows.length);
    for (let rowIndex = 0; rowIndex < previewLimit; rowIndex += 1) {
      const tr = document.createElement("tr");
      result.rows[rowIndex].forEach((value) => {
        const td = document.createElement("td");
        td.textContent = displayValue(value);
        tr.appendChild(td);
      });
      elements.resultTableBody.appendChild(tr);
    }
    elements.previewNote.textContent = result.rows.length > previewLimit
      ? `แสดง ${numberFormatter.format(previewLimit)} จาก ${numberFormatter.format(result.rows.length)} แถว`
      : `${numberFormatter.format(result.rows.length)} แถว`;

    elements.resultsSection.hidden = false;
    elements.exportButton.disabled = false;
    elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function rulesMatrix() {
    return [
      ["Result", "Primary Keywords", "Sub Keywords", "Rule Row"],
      ...state.rules.map((rule) => [rule.result, rule.primaryKeywords, rule.subKeywords, rule.rowNumber])
    ];
  }

  function summaryMatrix() {
    const result = state.result;
    const modeText = result.mode === "smart" ? "Smart / specific-first" : "Row order";
    return [
      ["รายการ", "ค่า"],
      ["Source", state.sourceName],
      ["Worksheet", state.sourceSheets[state.activeSheetIndex]?.name || ""],
      ["SHOP_NAME Column", state.headers[state.selectedColumnIndex] || ""],
      ["Rules Source", state.rulesSource],
      ["Match Mode", modeText],
      ["Processed At", result.processedAt.toISOString()],
      ["Total", result.summary.total],
      ["Matched", result.summary.matched],
      ["Unmatched", result.summary.unmatched],
      [],
      ["Result", "Count"],
      ...result.summary.counts.map((item) => [item.result, item.count])
    ];
  }

  function filenameTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function exportResult() {
    if (!state.result) return;
    const resultSheet = [state.result.headers, ...state.result.rows];
    const filename = `shop_result_${filenameTimestamp(new Date())}.xlsx`;
    MiniXLSX.downloadWorkbook([
      { name: "Result", rows: resultSheet, freezeHeader: true, autoFilter: true },
      { name: "Summary", rows: summaryMatrix(), freezeHeader: true, autoFilter: false },
      { name: "Rules_Used", rows: rulesMatrix(), freezeHeader: true, autoFilter: true }
    ], filename);
    showToast(`สร้างไฟล์ ${filename} แล้ว`);
  }

  function exportRules() {
    const filename = `shop_rules_${filenameTimestamp(new Date())}.xlsx`;
    MiniXLSX.downloadWorkbook([{ name: "Rules", rows: rulesMatrix(), freezeHeader: true, autoFilter: true }], filename);
    showToast(`สร้างไฟล์ ${filename} แล้ว`);
  }

  async function handleDataFile(file) {
    if (!file) return;
    setStatus(elements.sourceStatus, "กำลังอ่านไฟล์…", "warning");
    elements.processMessage.textContent = "";
    try {
      const sheets = await readInputFile(file);
      loadSourceSheets(sheets, file.name, "file");
      showToast(`นำเข้า ${file.name} สำเร็จ`);
    } catch (error) {
      setStatus(elements.sourceStatus, "อ่านไฟล์ไม่สำเร็จ", "danger");
      showToast(error.message || String(error), true);
    } finally {
      elements.dataFileInput.value = "";
    }
  }

  async function handleRulesFile(file) {
    if (!file) return;
    setStatus(elements.rulesStatus, "กำลังอ่านกติกา…", "warning");
    try {
      const sheets = await readInputFile(file);
      const extracted = extractRulesFromSheets(sheets);
      state.ruleRows = extracted.rows;
      state.rules = extracted.prepared;
      state.rulesSource = `${file.name} / ${extracted.sheetName}`;
      renderRules();
      resetResult();
      showToast(`โหลดกติกา ${state.rules.length} แถวสำเร็จ`);
    } catch (error) {
      setStatus(elements.rulesStatus, "กติกาไม่ถูกต้อง", "danger");
      showToast(error.message || String(error), true);
      renderRules();
    } finally {
      elements.rulesFileInput.value = "";
    }
  }

  elements.tabs.forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

  elements.loadPasteButton.addEventListener("click", () => {
    const text = elements.pasteInput.value;
    if (!text.trim()) return showToast("กรุณาวางข้อมูลก่อน", true);
    try {
      const matrix = MiniXLSX.parseDelimited(text);
      loadSourceSheets([{ name: "Pasted Data", rows: matrix }], "ข้อมูลที่วาง", "paste");
      showToast("โหลดข้อมูลที่วางแล้ว");
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });

  elements.sampleButton.addEventListener("click", () => {
    elements.pasteInput.value = [
      "SHOP_NAME",
      "ร้านข้าวสาร (พรชัยค้าข้าว)",
      "ห้างท็อปส์ สาขารังสิต (ฟิวเจอร์พาร์ค รังสิต)",
      "ท็อปส์ เดลี่ สาขาสุขุมวิท",
      "กูรเมต์ มาร์เก็ต ซูเปอร์มาร์เก็ต The Mall Bangkapi",
      "ห้างโลตัสไฮเปอร์มาร์เก็ต สาขาพระโขนง",
      "โลตัส โกเฟรช (ตลาดไทเลย)",
      "ห้างเทสโก้ โลตัส",
      "บิ๊กซี ซูเปอร์เซ็นเตอร์",
      "บิ๊กซี มินิ",
      "ร้านที่ไม่ตรงกติกา"
    ].join("\n");
    switchTab("pastePanel");
  });

  elements.clearPasteButton.addEventListener("click", () => {
    elements.pasteInput.value = "";
    elements.pasteInput.focus();
  });

  elements.dataFileInput.addEventListener("change", (event) => handleDataFile(event.target.files[0]));
  elements.rulesFileInput.addEventListener("change", (event) => handleRulesFile(event.target.files[0]));

  ["dragenter", "dragover"].forEach((eventName) => elements.dataDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dataDropZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((eventName) => elements.dataDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dataDropZone.classList.remove("is-dragging");
  }));
  elements.dataDropZone.addEventListener("drop", (event) => handleDataFile(event.dataTransfer.files[0]));

  elements.sheetSelect.addEventListener("change", () => {
    state.activeSheetIndex = Number(elements.sheetSelect.value || 0);
    const sheet = state.sourceSheets[state.activeSheetIndex];
    elements.headerRowInput.value = String(detectDataHeaderRow(sheet.rows, state.sourceKind));
    updateSourceFromSheet();
  });
  elements.headerRowInput.addEventListener("change", updateSourceFromSheet);
  elements.shopColumnSelect.addEventListener("change", () => {
    state.selectedColumnIndex = Number(elements.shopColumnSelect.value || 0);
    const nonBlankShopRows = state.rows.filter((row) => !isBlank(row[state.selectedColumnIndex])).length;
    setStatus(elements.sourceStatus, `${numberFormatter.format(nonBlankShopRows)} ร้าน`, "success");
    resetResult();
  });

  elements.resetRulesButton.addEventListener("click", () => {
    state.ruleRows = ShopClassifier.DEFAULT_RULE_ROWS.map((row) => ({ ...row }));
    state.rules = ShopClassifier.DEFAULT_RULES;
    state.rulesSource = "shop.xlsx (ค่าเริ่มต้น)";
    renderRules();
    resetResult();
    showToast("กลับไปใช้กติกาเริ่มต้นแล้ว");
  });
  elements.exportRulesButton.addEventListener("click", exportRules);

  elements.processButton.addEventListener("click", async () => {
    elements.processButton.disabled = true;
    elements.processMessage.textContent = "กำลังประมวลผล…";
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      processRows();
      renderResults();
      elements.processMessage.textContent = `ประมวลผล ${numberFormatter.format(state.result.rows.length)} แถวสำเร็จ`;
      showToast("ประมวลผลเสร็จแล้ว");
    } catch (error) {
      elements.processMessage.textContent = "";
      showToast(error.message || String(error), true);
    } finally {
      elements.processButton.disabled = false;
    }
  });

  elements.exportButton.addEventListener("click", exportResult);

  renderRules();
})();
